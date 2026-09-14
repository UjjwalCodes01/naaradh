import { memoryMailer } from '@naaradh/notify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { createDb } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import { addMinutes, createLogger, generatePhoneKeyPair, hashPhone, newId } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { EngineRegistry } from '@naaradh/engines-registry';
import type { WorkerContext } from '../../src/context.js';
import { inlineSecretResolver } from '../../src/deliveries/secrets.js';
import { runDispatcher } from '../../src/dispatcher/loop.js';
import { runReconcile } from '../../src/reconcile/index.js';
import { memoryRecordingStore } from '../../src/results/recordings.js';
import { recordingWriteback } from '../../src/results/writeback.js';

/**
 * Chaos (P3-INF-4, AGENTS §12 "DB failover"): the always-on loops keep running through a
 * Postgres failover (every connection terminated by the server, as on a Neon compute restart)
 * and a Redis failover (server stalled, every client dropped), and process the work that
 * arrives afterwards. Engine
 * failure modes (5xx opening the breaker, 429 backoff, timeout-uncertain) and duplicate /
 * out-of-order / missing webhooks are covered by e2e.test.ts ("vendor failure modes",
 * "redelivering the same engine webhook is a no-op") — not repeated here.
 */

const T = newId('tenant');
const HASH_KEY = 'h'.repeat(32);
const keyPair = generatePhoneKeyPair();
const clock = { now: () => new Date() };

let pg: TestPostgres;
let redisContainer: StartedRedisContainer;
let redis: Redis;
let service: RoleClient;
let ctx: WorkerContext;
let closers: (() => Promise<void>)[] = [];
let useCaseId = '';
let contactId = '';
const controller = new AbortController();
const loops: Promise<void>[] = [];

const q = async <R extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await service.query<R>(text, params)).rows;

/** A SCHEDULED intent whose envelope already closed: reconcile must mark it EXPIRED. */
async function expiredIntent(): Promise<string> {
  const id = newId('intent');
  const at = addMinutes(clock.now(), -40);
  await q(
    `insert into call_intents (id, tenant_id, use_case_id, use_case, purpose, contact_id, phone_hash, recipient_region, source, external_ref, external_refs,
       event_ts, not_before, not_after, status, locale, idempotency_key, variables, next_attempt_at, created_at)
     values ($1, $2, $3, 'cod_confirm', 'transactional', $4, $5, 'IN', 'shopify', $6, array[$6], $7, $7, $7::timestamptz + interval '30 minutes', 'SCHEDULED', 'hi-IN', $8, '{}', $7, $7)`,
    [
      id,
      T,
      useCaseId,
      contactId,
      hashPhone(FAKE_IN.customer, HASH_KEY),
      `ord-${id.slice(-8)}`,
      at,
      `idem-${id}`,
    ],
  );
  return id;
}

async function statusOf(id: string): Promise<string | undefined> {
  const rows = await q<{ status: string }>(`select status from call_intents where id = $1`, [id]);
  return rows[0]?.status;
}

async function eventually(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return check().catch(() => false);
}

beforeAll(async () => {
  pg = await startTestPostgres();
  redisContainer = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(redisContainer.getConnectionUrl(), { maxRetriesPerRequest: 1 });
  redis.on('error', () => undefined); // reconnects are expected here; the workers log these
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
    log: createLogger({ service: 'chaos-int', level: 'silent' }),
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
    workerId: 'chaos-int',
    dispatchBatch: 10,
  };
  // The two always-on loops, polling fast so the test does not wait on the production cadence.
  loops.push(runReconcile(ctx, 300, controller.signal));
  loops.push(runDispatcher(ctx, 300, controller.signal));
}, 240_000);

afterAll(async () => {
  controller.abort();
  await Promise.allSettled(loops);
  for (const c of closers) await c();
  await service.end();
  redis.disconnect();
  await redisContainer.stop();
  await pg.stop();
});

describe('loops survive infrastructure restarts', () => {
  it('baseline: reconcile expires an overdue intent within seconds', async () => {
    const id = await expiredIntent();
    expect(await eventually(async () => (await statusOf(id)) === 'EXPIRED', 15_000)).toBe(true);
  }, 30_000);

  it('Postgres fails over (every connection terminated): the loops keep running and process work', async () => {
    // Do it three times in a row so the pools' retry logic is exercised, not just one dead client.
    for (let i = 0; i < 3; i += 1) {
      await pg.disconnectAll();
      await new Promise((r) => setTimeout(r, 400));
    }
    const intent = await expiredIntent();
    expect(await eventually(async () => (await statusOf(intent)) === 'EXPIRED', 40_000)).toBe(true);
    // The loops are the same promises as before — neither has settled (i.e. crashed).
    const settled = await Promise.race([
      Promise.any(loops).then(() => true),
      new Promise<boolean>((r) => {
        setTimeout(() => {
          r(false);
        }, 100);
      }),
    ]);
    expect(settled).toBe(false);
  }, 120_000);

  it('Redis fails over (server paused, then every client killed): same', async () => {
    // DEBUG SLEEP blocks the server (commands stall/time out); CLIENT KILL drops every connection.
    await redisContainer.exec(['redis-cli', 'DEBUG', 'SLEEP', '2']);
    await redisContainer.exec(['redis-cli', 'CLIENT', 'KILL', 'TYPE', 'normal']);
    expect(
      await eventually(async () => {
        await redis.ping();
        return true;
      }, 30_000),
    ).toBe(true);
    const intent = await expiredIntent();
    expect(await eventually(async () => (await statusOf(intent)) === 'EXPIRED', 40_000)).toBe(true);
    const settled = await Promise.race([
      Promise.any(loops).then(() => true),
      new Promise<boolean>((r) => {
        setTimeout(() => {
          r(false);
        }, 100);
      }),
    ]);
    expect(settled).toBe(false);
  }, 120_000);
});
