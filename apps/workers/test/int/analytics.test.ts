import { memoryMailer } from '@naaradh/notify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { createDb } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import { billedMinutes } from '@naaradh/pipeline';
import { createLogger, generatePhoneKeyPair, hashPhone, newId } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { EngineRegistry } from '@naaradh/engines-registry';
import type { WorkerContext } from '../../src/context.js';
import { inlineSecretResolver } from '../../src/deliveries/secrets.js';
import { memoryRecordingStore } from '../../src/results/recordings.js';
import { recordingWriteback } from '../../src/results/writeback.js';
import {
  ANALYTICS_WATERMARK,
  DAILY_FACT_KEYS,
  dailyCallFacts,
  daysOwed,
  exportOwedDays,
  memorySink,
  runAnalyticsOnce,
  type DailyFact,
} from '../../src/analytics/index.js';

/**
 * Nightly BigQuery facts (P2-INF-2): the aggregation on real Postgres — billable per invariant
 * 11, inbound minutes rounded up per call, ledger amounts, the IST day boundary — and the
 * export's replace-the-day idempotency, lock and watermark. And the property that matters
 * most: no per-subject value in any row (invariant 8).
 */

const TA = newId('tenant');
const TB = newId('tenant');
const HASH_KEY = 'h'.repeat(32);
const keyPair = generatePhoneKeyPair();
// 15 Sep 2026 03:00 IST — after the nightly window; "yesterday" is 14 Sep.
const current = new Date('2026-09-14T21:30:00Z');
const clock = { now: () => new Date(current.getTime()) };

let pg: TestPostgres;
let redisContainer: StartedRedisContainer;
let redis: Redis;
let service: RoleClient;
let ctx: WorkerContext;
let closers: (() => Promise<void>)[] = [];
const useCase: Record<string, string> = {};
const contact: Record<string, string> = {};
const profile: Record<string, string> = {};

const q = async <R extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await service.query<R>(text, params)).rows;
const h = (e164: string) => hashPhone(e164, HASH_KEY);

interface AttemptSpec {
  tenant: string;
  direction: 'outbound' | 'inbound';
  endedAt: Date;
  answeredBy: 'human' | 'machine' | null;
  outcome?: { value: string; billable: boolean };
  durationSec?: number;
  billableSec?: number | null;
  humanSpeechSec?: number;
  /** Ledger row linked to the attempt (outcome id) or the call (attempt id). */
  charge?: { kind: 'outcome' | 'minute'; totalMinor: number; overage?: number };
}

async function attempt(spec: AttemptSpec): Promise<string> {
  const attemptId = newId('attempt');
  let intentId: string | null = null;
  if (spec.direction === 'outbound') {
    intentId = newId('intent');
    await q(
      `insert into call_intents (id, tenant_id, use_case_id, use_case, purpose, contact_id, phone_hash, recipient_region, source, external_ref, external_refs,
         event_ts, not_before, not_after, status, locale, idempotency_key, variables, created_at)
       values ($1, $2, $3, 'cod_confirm', 'transactional', $4, $5, 'IN', 'shopify', $6, array[$6], $7, $7, $7::timestamptz + interval '30 minutes', 'COMPLETED', 'hi-IN', $8, '{"customer_name":"Asha Test"}', $7)`,
      [
        intentId,
        spec.tenant,
        useCase[spec.tenant],
        contact[spec.tenant],
        h(FAKE_IN.customer),
        `ord-${intentId.slice(-8)}`,
        spec.endedAt,
        `idem-${intentId}`,
      ],
    );
  }
  const answered = spec.answeredBy === 'human' ? spec.endedAt : null;
  await q(
    `insert into call_attempts (id, tenant_id, intent_id, contact_id, phone_hash, direction, purpose, attempt_no, engine, from_e164,
       amd_mode, max_duration_sec, idempotency_key, status, answered_by, dispatched_at, ended_at, end_reason, created_at,
       answered_at, ai_disclosed_at, recording_disclosed_at, duration_sec, billable_sec, human_speech_sec, inbound_profile_id)
     values ($1, $2, $3, $4, $5, $6, $7, 1, 'simulator', $8, 'continue', 120, $1, 'ENDED', $9, $10, $10, 'completed', $10,
       $11, $11, $11, $12, $13, $14, $15)`,
    [
      attemptId,
      spec.tenant,
      intentId,
      contact[spec.tenant],
      h(FAKE_IN.customer),
      spec.direction,
      spec.direction === 'inbound' ? 'service' : 'transactional',
      FAKE_IN.merchant,
      spec.answeredBy,
      spec.endedAt,
      answered,
      spec.durationSec ?? null,
      spec.billableSec === undefined ? null : spec.billableSec,
      spec.humanSpeechSec ?? null,
      spec.direction === 'inbound' ? profile[spec.tenant] : null,
    ],
  );
  let outcomeId: string | null = null;
  if (spec.outcome !== undefined) {
    outcomeId = newId('outcome');
    await q(
      `insert into call_outcomes (id, tenant_id, attempt_id, intent_id, outcome, confidence, extracted, extraction_method, billable, billable_reason, superseded)
       values ($1, $2, $3, $4, $5, 0.95, '{"notes":"asked for Asha"}', 'engine', $6, 'test', $7)`,
      [
        outcomeId,
        spec.tenant,
        attemptId,
        intentId,
        spec.outcome.value,
        spec.outcome.billable,
        spec.outcome.value === 'outcome_superseded',
      ],
    );
  }
  if (spec.charge !== undefined) {
    const ref = spec.charge.kind === 'outcome' ? outcomeId : attemptId;
    await q(
      `insert into billing_ledger (id, tenant_id, kind, ref, qty, unit_minor, total_minor, currency, period, provider)
       values ($1, $2, $3, $4, 1, $5, $5, 'INR', '2026-09', 'manual')`,
      [newId('ledger'), spec.tenant, spec.charge.kind, ref, spec.charge.totalMinor],
    );
    if (spec.charge.overage !== undefined)
      await q(
        `insert into billing_ledger (id, tenant_id, kind, ref, qty, unit_minor, total_minor, currency, period, provider)
         values ($1, $2, 'minute', $3, 1, $4, $4, 'INR', '2026-09', 'manual')`,
        [newId('ledger'), spec.tenant, `${attemptId}:overage`, spec.charge.overage],
      );
  }
  return attemptId;
}

beforeAll(async () => {
  pg = await startTestPostgres();
  redisContainer = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(redisContainer.getConnectionUrl());
  service = new RoleClient(pg.urls.service);
  for (const [id, name] of [
    [TA, 'Client A'],
    [TB, 'Client B'],
  ] as const) {
    await q(
      `insert into tenants (id, name, country, data_region, status, billing_status) values ($1, $2, 'IN', 'in', 'active', 'active')`,
      [id, name],
    );
    useCase[id] = newId('useCase');
    await q(
      `insert into use_cases (id, tenant_id, kind, purpose, enabled) values ($1, $2, 'cod_confirm', 'transactional', true)`,
      [useCase[id], id],
    );
    profile[id] = newId('inboundProfile');
    await q(
      `insert into inbound_profiles (id, tenant_id, name, status, greeting, business_hours, tools_enabled, pinned_facts, closed_message)
       values ($1, $2, 'Support', 'active', 'Namaste, main Client ki taraf se automated AI assistant bol rahi hoon. Yeh call record ho rahi hai.',
               '{"zone":"Asia/Kolkata","days":[1,2,3,4,5],"open":"09:00","close":"18:00"}', array['lookup_order'], array[]::text[], 'Band hai.')`,
      [profile[id], id],
    );
    contact[id] = newId('contact');
    await q(
      `insert into contacts (id, tenant_id, phone_hash, phone_enc, phone_enc_kid, phone_masked, region, name)
       values ($1, $2, $3, '\\x00', 1, '+91 60xxx xx001', 'IN', 'Asha Test')`,
      [contact[id], id, h(FAKE_IN.customer)],
    );
  }

  // 14 Sep IST runs 2026-09-13T18:30Z … 2026-09-14T18:30Z.
  const d14 = new Date('2026-09-14T06:00:00Z');
  // Tenant A, outbound: two confirmed+billable (₹8 each), one machine-answered, one superseded.
  await attempt({
    tenant: TA,
    direction: 'outbound',
    endedAt: d14,
    answeredBy: 'human',
    outcome: { value: 'confirmed', billable: true },
    humanSpeechSec: 40,
    charge: { kind: 'outcome', totalMinor: 800 },
  });
  await attempt({
    tenant: TA,
    direction: 'outbound',
    endedAt: d14,
    answeredBy: 'human',
    outcome: { value: 'confirmed', billable: true },
    humanSpeechSec: 35,
    charge: { kind: 'outcome', totalMinor: 800 },
  });
  await attempt({
    tenant: TA,
    direction: 'outbound',
    endedAt: d14,
    answeredBy: 'machine',
    outcome: { value: 'voicemail', billable: false },
  });
  await attempt({
    tenant: TA,
    direction: 'outbound',
    endedAt: d14,
    answeredBy: 'human',
    outcome: { value: 'outcome_superseded', billable: false },
    humanSpeechSec: 12,
  });
  // Belt and braces: a human-answered "confirmed" whose stored verdict is false stays unbillable.
  await attempt({
    tenant: TA,
    direction: 'outbound',
    endedAt: d14,
    answeredBy: 'human',
    outcome: { value: 'confirmed', billable: false },
    humanSpeechSec: 3,
  });
  // Tenant B, inbound: 61 s → 2 minutes (₹6 + ₹6 overage), 30 s → 1 minute.
  await attempt({
    tenant: TB,
    direction: 'inbound',
    endedAt: d14,
    answeredBy: 'human',
    durationSec: 61,
    billableSec: 61,
    charge: { kind: 'minute', totalMinor: 600, overage: 600 },
  });
  await attempt({
    tenant: TB,
    direction: 'inbound',
    endedAt: d14,
    answeredBy: 'human',
    durationSec: 30,
    billableSec: null,
  });
  // Day boundary: 18:45Z on the 13th is already the 14th in IST; 18:15Z is still the 13th.
  await attempt({
    tenant: TB,
    direction: 'outbound',
    endedAt: new Date('2026-09-13T18:45:00Z'),
    answeredBy: 'machine',
    outcome: { value: 'no_answer', billable: false },
  });
  await attempt({
    tenant: TB,
    direction: 'outbound',
    endedAt: new Date('2026-09-13T18:15:00Z'),
    answeredBy: 'machine',
    outcome: { value: 'no_answer', billable: false },
  });

  const a = createDb({ url: pg.urls.app, max: 3 });
  const s = createDb({ url: pg.urls.service, max: 3 });
  closers = [a.close, s.close];
  ctx = {
    app: a.db,
    service: s.db,
    redis,
    registry: new EngineRegistry({
      env: {
        ENGINE_DEFAULT_IN: 'simulator',
        ENGINE_DEFAULT_US: 'simulator',
        SIMULATOR_WEBHOOK_SECRET: 'x'.repeat(20),
      },
    }),
    log: createLogger({ service: 'analytics-int', level: 'silent' }),
    clock,
    keys: {
      hashKey: HASH_KEY,
      encPublicKeyPem: keyPair.publicKeyPem,
      encKid: 1,
      privateKeyPem: keyPair.privateKeyPem,
    },
    gate: {
      engines: {
        defaultIn: 'simulator',
        defaultUs: 'simulator',
        secondaryIn: null,
        secondaryUs: null,
        maxConcurrency: { simulator: 20 },
      },
      engineDailyCapPaise: { simulator: 50_000_00 },
      globalDailyCapPaise: 200_000_00,
    },
    hooksBaseUrl: 'http://hooks.test',
    voiceBaseUrl: 'http://voice.test',
    engineWebhookKey: 'k'.repeat(32),
    recordings: memoryRecordingStore(),
    shopify: recordingWriteback(),
    secrets: inlineSecretResolver(),
    shopifyAdmin: { apiVersion: '2026-07' },
    razorpay: null,
    mailer: memoryMailer(),
    dashboardUrl: 'https://app.naaradh.test',
    workerId: 'analytics-int',
    dispatchBatch: 10,
  };
}, 240_000);

afterAll(async () => {
  for (const c of closers) await c();
  await service.end();
  redis.disconnect();
  await redisContainer.stop();
  await pg.stop();
});

const key = (r: DailyFact) =>
  `${r.tenant_id === TA ? 'A' : 'B'} ${r.direction} ${r.use_case ?? '-'} ${r.outcome ?? '-'} ${String(r.billable)}`;

describe('dailyCallFacts', () => {
  it('aggregates the IST day with invariant-11 billability, rounded-up minutes and ledger amounts', async () => {
    const rows = await dailyCallFacts(ctx.service, '2026-09-14');
    const byKey = new Map(rows.map((r) => [key(r), r]));
    expect([...byKey.keys()].sort()).toEqual([
      'A outbound cod_confirm confirmed false',
      'A outbound cod_confirm confirmed true',
      'A outbound cod_confirm outcome_superseded false',
      'A outbound cod_confirm voicemail false',
      'B inbound inbound_support - false',
      'B outbound cod_confirm no_answer false',
    ]);
    expect(byKey.get('A outbound cod_confirm confirmed true')).toMatchObject({
      attempts: 2,
      human_speech_sec: 75,
      amount_minor: 1600,
      currency: 'INR',
      minutes: null,
      pincode_band: null,
      state: null,
    });
    expect(byKey.get('A outbound cod_confirm confirmed false')?.amount_minor).toBeNull();
    const inbound = byKey.get('B inbound inbound_support - false');
    expect(inbound).toMatchObject({ attempts: 2, minutes: 3, amount_minor: 1200 });
    // The SQL rounding is the same arithmetic as the metering code.
    expect(billedMinutes(61) + billedMinutes(30)).toBe(3);
    // Only the 18:45Z call is on the 14th.
    expect(byKey.get('B outbound cod_confirm no_answer false')?.attempts).toBe(1);
    expect((await dailyCallFacts(ctx.service, '2026-09-13')).map(key)).toEqual([
      'B outbound cod_confirm no_answer false',
    ]);
    expect(await dailyCallFacts(ctx.service, '2026-09-01')).toEqual([]);
  });

  it('carries nothing per subject (invariant 8): exactly the schema keys, no ids or numbers', async () => {
    const rows = await dailyCallFacts(ctx.service, '2026-09-14');
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual([...DAILY_FACT_KEYS].sort());
      for (const [k, v] of Object.entries(r)) {
        if (k === 'tenant_id') continue;
        if (typeof v === 'string') {
          expect(v, k).not.toMatch(/^\+?\d{10,}$/);
          expect(v, k).not.toMatch(/^(att|int|con|out|ord|led)_/);
          expect(v, k).not.toContain('Asha');
        }
      }
    }
  });
});

describe('export', () => {
  it('daysOwed backfills 7 days on first run, then continues from the watermark', () => {
    expect(daysOwed(null, '2026-09-14')).toEqual([
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
      '2026-09-14',
    ]);
    expect(daysOwed('2026-09-12', '2026-09-14')).toEqual(['2026-09-13', '2026-09-14']);
    expect(daysOwed('2026-09-14', '2026-09-14')).toEqual([]);
  });

  it('loads each owed day once, replaces on re-run, and a failing sink leaves the watermark', async () => {
    const sink = memorySink();
    await redis.set(ANALYTICS_WATERMARK, '2026-09-12');
    const first = await exportOwedDays(ctx, sink, clock.now());
    expect(first.days).toEqual(['2026-09-13', '2026-09-14']);
    expect(sink.days.get('2026-09-14')?.length).toBe(6);
    expect(await redis.get(ANALYTICS_WATERMARK)).toBe('2026-09-14');

    // Re-run for the same day: replaced, not appended.
    await redis.set(ANALYTICS_WATERMARK, '2026-09-13');
    await exportOwedDays(ctx, sink, clock.now());
    expect(sink.days.get('2026-09-14')?.length).toBe(6);
    expect(sink.loads).toBe(3);

    const failing = {
      loadDay: async () => {
        throw new Error('bigquery down');
      },
    };
    await redis.set(ANALYTICS_WATERMARK, '2026-09-12');
    await expect(exportOwedDays(ctx, failing, clock.now())).rejects.toThrow('bigquery down');
    expect(await redis.get(ANALYTICS_WATERMARK)).toBe('2026-09-12');
  });

  it('runs once per local day after 01:30, under a lock, and retries after a failure', async () => {
    await redis.flushall();
    const sink = memorySink();
    // 01:00 IST — too early.
    expect(await runAnalyticsOnce(ctx, sink, new Date('2026-09-14T19:30:00Z'))).toBeNull();
    const failing = {
      loadDay: async () => {
        throw new Error('bigquery down');
      },
    };
    await expect(runAnalyticsOnce(ctx, failing, clock.now())).rejects.toThrow('bigquery down');
    // The failure released the lock and did not mark the day done: the next tick runs again.
    const report = await runAnalyticsOnce(ctx, sink, clock.now());
    expect(report?.days.length).toBe(7);
    expect(await runAnalyticsOnce(ctx, sink, clock.now())).toBeNull();
    // Next local day: yesterday is the 15th; only that day is owed.
    const next = await runAnalyticsOnce(ctx, sink, new Date('2026-09-15T21:30:00Z'));
    expect(next?.days).toEqual(['2026-09-15']);
  });
});
