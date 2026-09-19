import { memoryMailer } from '@naaradh/notify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { createDb } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import { addDays, createLogger, generatePhoneKeyPair, hashPhone, newId } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { EngineRegistry } from '@naaradh/engines-registry';
import type { WorkerContext } from '../../src/context.js';
import { inlineSecretResolver } from '../../src/deliveries/secrets.js';
import { memoryRecordingStore } from '../../src/results/recordings.js';
import { recordingWriteback } from '../../src/results/writeback.js';
import {
  CLI_HEALTH_MIN_SAMPLE,
  computeCliHealth,
  runCliHealthDaily,
} from '../../src/cli-health/index.js';

/**
 * E-28 number health on real Postgres + Redis: the 7-day human-answer rate per CLI, the minimum
 * sample, what counts as a dial, the once-a-day guard, and the audit row when a number drops
 * below the gate's threshold.
 */

const T = newId('tenant');
const HASH_KEY = 'h'.repeat(32);
const keyPair = generatePhoneKeyPair();
// 2026-09-14 08:00 IST
const current = new Date('2026-09-14T02:30:00Z');
const clock = { now: () => new Date(current.getTime()) };

let pg: TestPostgres;
let redisContainer: StartedRedisContainer;
let redis: Redis;
let service: RoleClient;
let ctx: WorkerContext;
let closers: (() => Promise<void>)[] = [];
let useCaseId = '';
let contactId = '';

const q = async <R extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await service.query<R>(text, params)).rows;

const NUMBERS = {
  low: newId('number'),
  fine: newId('number'),
  fewCalls: newId('number'),
  onlyErrors: newId('number'),
  retiredLow: newId('number'),
} as const;

async function number(id: string, suffix: string, status = 'active', rate: string | null = null) {
  await q(
    `insert into numbers (id, tenant_id, e164, region, series, provider, engine, purpose_allowed, status, answer_rate_7d)
     values ($1, null, $2, 'IN', '10digit', 'simulator', 'simulator', array['transactional']::purpose[], $3, $4)`,
    [id, `+91600000${suffix}`, status, rate],
  );
}

/** One outbound attempt from `numberId`; `status` decides whether it counts as a dial. */
async function attempt(
  numberId: string,
  status: string,
  answeredBy: 'human' | 'machine' | null,
  opts: { daysAgo?: number } = {},
) {
  const at = addDays(clock.now(), -(opts.daysAgo ?? 1));
  const intentId = newId('intent');
  await q(
    `insert into call_intents (id, tenant_id, use_case_id, use_case, purpose, contact_id, phone_hash, recipient_region, source, external_ref, external_refs,
       event_ts, not_before, not_after, status, locale, idempotency_key, variables, created_at)
     values ($1, $2, $3, 'cod_confirm', 'transactional', $4, $5, 'IN', 'shopify', $6, array[$6], $7, $7, $7::timestamptz + interval '30 minutes', 'COMPLETED', 'hi-IN', $8, '{}', $7)`,
    [
      intentId,
      T,
      useCaseId,
      contactId,
      hashPhone(FAKE_IN.customer, HASH_KEY),
      `ord-${intentId.slice(-8)}`,
      at,
      `idem-${intentId}`,
    ],
  );
  const attemptId = newId('attempt');
  await q(
    `insert into call_attempts (id, tenant_id, intent_id, contact_id, phone_hash, direction, purpose, attempt_no, engine, from_e164, number_id,
       amd_mode, max_duration_sec, idempotency_key, status, answered_by, dispatched_at, ended_at, end_reason, created_at,
       answered_at, ai_disclosed_at, recording_disclosed_at)
     values ($1, $2, $3, $4, $5, 'outbound', 'transactional', 1, 'simulator', $6, $7, 'continue', 120, $1, $8, $9, $10, $10, $11, $10,
       $12, $12, $12)`,
    [
      attemptId,
      T,
      intentId,
      contactId,
      hashPhone(FAKE_IN.customer, HASH_KEY),
      FAKE_IN.merchant,
      numberId,
      status,
      answeredBy,
      at,
      status === 'FAILED' ? 'engine_error' : 'completed',
      // Invariant 7: an answered call carries both disclosures (trigger-enforced).
      answeredBy === 'human' ? at : null,
    ],
  );
}

const rateOf = async (id: string) =>
  (
    await q<{ answer_rate_7d: string | null }>(`select answer_rate_7d from numbers where id = $1`, [
      id,
    ])
  )[0]?.answer_rate_7d ?? null;

beforeAll(async () => {
  pg = await startTestPostgres();
  redisContainer = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(redisContainer.getConnectionUrl());
  service = new RoleClient(pg.urls.service);
  await q(
    `insert into tenants (id, name, country, data_region, status, billing_status) values ($1, 'Client A', 'IN', 'in', 'active', 'active')`,
    [T],
  );
  useCaseId = newId('useCase');
  await q(
    `insert into use_cases (id, tenant_id, kind, purpose, enabled) values ($1, $2, 'cod_confirm', 'transactional', true)`,
    [useCaseId, T],
  );
  contactId = newId('contact');
  await q(
    `insert into contacts (id, tenant_id, phone_hash, phone_enc, phone_enc_kid, phone_masked, region)
     values ($1, $2, $3, '\\x00', 1, '+91 60xxx xx001', 'IN')`,
    [contactId, T, hashPhone(FAKE_IN.customer, HASH_KEY)],
  );

  await number(NUMBERS.low, '0200');
  await number(NUMBERS.fine, '0201');
  await number(NUMBERS.fewCalls, '0202');
  await number(NUMBERS.onlyErrors, '0203');
  await number(NUMBERS.retiredLow, '0204', 'retired', '0.1000');

  // low: 30 dials, 5 humans → 0.1667. Plus old calls that must not count.
  for (let i = 0; i < 30; i += 1) await attempt(NUMBERS.low, 'ENDED', i < 5 ? 'human' : 'machine');
  for (let i = 0; i < 10; i += 1) await attempt(NUMBERS.low, 'ENDED', 'human', { daysAgo: 9 });
  // fine: 30 dials (some no-answer), 20 humans → 0.6667. Cancelled/failed rows are not dials.
  for (let i = 0; i < 30; i += 1)
    await attempt(NUMBERS.fine, i < 20 ? 'ENDED' : 'NO_ANSWER', i < 20 ? 'human' : null);
  for (let i = 0; i < 5; i += 1) await attempt(NUMBERS.fine, 'FAILED', null);
  for (let i = 0; i < 5; i += 1) await attempt(NUMBERS.fine, 'CANCELLED', null);
  // fewCalls: below the minimum sample.
  for (let i = 0; i < CLI_HEALTH_MIN_SAMPLE - 1; i += 1)
    await attempt(NUMBERS.fewCalls, 'ENDED', 'machine');
  // onlyErrors: the engine failed every time — says nothing about the number.
  for (let i = 0; i < 30; i += 1) await attempt(NUMBERS.onlyErrors, 'FAILED', null);

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
    log: createLogger({ service: 'cli-health-int', level: 'silent' }),
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
    stripe: null,
    mailer: memoryMailer(),
    dashboardUrl: 'https://app.naaradh.test',
    workerId: 'cli-health-int',
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

describe('computeCliHealth (E-28)', () => {
  it('rates each number on the last 7 days of real dials, with a minimum sample', async () => {
    const report = await computeCliHealth(ctx, clock.now());
    expect(report).toEqual({ numbers: 5, rated: 2, belowThreshold: 1, newlyBelow: 1 });
    expect(await rateOf(NUMBERS.low)).toBe('0.1667');
    expect(await rateOf(NUMBERS.fine)).toBe('0.6667');
    expect(await rateOf(NUMBERS.fewCalls)).toBeNull();
    expect(await rateOf(NUMBERS.onlyErrors)).toBeNull();
    // A retired number with no recent dials loses its stale rate: "no data" for when it is rested back in.
    expect(await rateOf(NUMBERS.retiredLow)).toBeNull();
  });

  it('audits the crossing once, never per run, and never retires anything itself', async () => {
    const before = await q<{ target_id: string; after: { dialed: number; human: number } }>(
      `select target_id, after from audit_log where action = 'cli.low_answer_rate'`,
    );
    expect(before.map((r) => r.target_id)).toEqual([NUMBERS.low]);
    expect(before[0]?.after).toMatchObject({ dialed: 30, human: 5, answer_rate_7d: 0.1667 });

    const again = await computeCliHealth(ctx, clock.now());
    expect(again.newlyBelow).toBe(0);
    expect((await q(`select 1 from audit_log where action = 'cli.low_answer_rate'`)).length).toBe(
      1,
    );
    expect(
      (await q<{ status: string }>(`select status from numbers where id = $1`, [NUMBERS.low]))[0]
        ?.status,
    ).toBe('active');
  });
});

describe('runCliHealthDaily', () => {
  it('runs once per local day after 02:00 IST, whichever worker gets the lock', async () => {
    // 01:30 IST — too early.
    expect(await runCliHealthDaily(ctx, new Date('2026-09-15T20:00:00Z'))).toBeNull();
    // 02:30 IST on 16 Sep — runs.
    const first = await runCliHealthDaily(ctx, new Date('2026-09-15T21:00:00Z'));
    expect(first?.numbers).toBe(5);
    // Later the same local day — already done.
    expect(await runCliHealthDaily(ctx, new Date('2026-09-16T05:00:00Z'))).toBeNull();
    // Next local day — runs again.
    expect((await runCliHealthDaily(ctx, new Date('2026-09-16T21:00:00Z')))?.numbers).toBe(5);
  });
});
