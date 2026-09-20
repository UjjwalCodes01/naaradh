import { memoryMailer } from '@naaradh/notify';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { createDb, type Db } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import {
  addMinutes,
  createLogger,
  engineWebhookPath,
  generatePhoneKeyPair,
  hashPhone,
  newId,
  sha256Hex,
} from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { EngineRegistry } from '@naaradh/engines-registry';
import { COD_CONFIRM_HI_IN } from '@naaradh/call-scripts';
import { buildServer as buildHooks } from '../../../hooks/src/server.js';
import { memoryPublisher } from '../../../hooks/src/pubsub.js';
import type { WorkerContext } from '../../src/context.js';
import { deliverOnce } from '../../src/deliveries/index.js';
import { inlineSecretResolver } from '../../src/deliveries/secrets.js';
import { dispatchOnce } from '../../src/dispatcher/loop.js';
import { handleShopifyEvent } from '../../src/intents/consumer.js';
import { reconcileOnce } from '../../src/reconcile/index.js';
import { runWritebacksOnce } from '../../src/writebacks/index.js';
import { handleEngineEvent } from '../../src/results/consumer.js';
import { memoryRecordingStore } from '../../src/results/recordings.js';
import { recordingWriteback } from '../../src/results/writeback.js';

/**
 * The Phase 1 exit proof, on real Postgres + Redis with the simulator engine:
 * a Shopify order becomes a call and a billable outcome, and every unhappy path lands
 * where the spec says it must.
 */

const TENANT = newId('tenant');
const SHOP = 'client-a-e2e.myshopify.com';
const SHOPIFY_SECRET = 'shpss_e2e';
const SIM_SECRET = 'simulator_secret_for_e2e_tests';
const ENGINE_KEY = 'k'.repeat(32);
const HASH_KEY = 'h'.repeat(32);
const keyPair = generatePhoneKeyPair();

/** 12:00 IST on Monday 2026-09-14. */
let current = new Date('2026-09-14T06:30:00Z');
const clock = { now: () => new Date(current.getTime()) };
const advance = (minutes: number) => {
  current = addMinutes(current, minutes);
};

let pg: TestPostgres;
let redisContainer: StartedRedisContainer;
let redis: Redis;
let service: RoleClient;
let appDb: Db;
let svcDb: Db;
let closers: (() => Promise<void>)[] = [];
let hooks: Awaited<ReturnType<typeof buildHooks>>;
let publisher: ReturnType<typeof memoryPublisher>;
let ctx: WorkerContext;
let writeback: ReturnType<typeof recordingWriteback>;
let orderSeq = 7000;

async function postOrder(
  phone: string | null,
  overrides: Record<string, unknown> = {},
): Promise<{ orderId: number }> {
  orderSeq += 1;
  const body = JSON.stringify({
    id: orderSeq,
    name: `#${String(orderSeq)}`,
    created_at: clock.now().toISOString(),
    currency: 'INR',
    total_price: '499.00',
    payment_gateway_names: ['Cash on Delivery (COD)'],
    customer: { first_name: 'Asha', last_name: 'Test', phone: null },
    shipping_address: { phone, zip: '110001', country_code: 'IN' },
    line_items: [{ title: 'Kurta', quantity: 1 }],
    ...overrides,
  });
  const r = await hooks.inject({
    method: 'POST',
    url: '/shopify/webhooks',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': SHOP,
      'x-shopify-webhook-id': `wh-${String(orderSeq)}`,
      'x-shopify-hmac-sha256': createHmac('sha256', SHOPIFY_SECRET).update(body).digest('base64'),
    },
  });
  expect(r.statusCode).toBe(200);
  return { orderId: orderSeq };
}

async function postShopifyTopic(topic: string, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload);
  const r = await hooks.inject({
    method: 'POST',
    url: '/shopify/webhooks',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': SHOP,
      'x-shopify-webhook-id': `wh-${topic}-${sha256Hex(body).slice(0, 8)}`,
      'x-shopify-hmac-sha256': createHmac('sha256', SHOPIFY_SECRET).update(body).digest('base64'),
    },
  });
  expect(r.statusCode).toBe(200);
}

/** Drains the memory bus the way the workers would, in arrival order. */
async function drain(): Promise<string[]> {
  const notes: string[] = [];
  while (publisher.messages.length > 0) {
    const { topic, message } = publisher.messages.shift() as (typeof publisher.messages)[number];
    if (topic === 'shopify.events') await handleShopifyEvent(ctx, message);
    else if (topic === 'engine.events') await handleEngineEvent(ctx, message);
    notes.push(`${topic}:${message.topic}`);
  }
  return notes;
}

const intentByOrder = async (orderId: number) =>
  (
    await service.query<{
      id: string;
      status: string;
      gated_reason: string | null;
      next_attempt_at: Date | null;
      attempts_count: number;
      not_after: Date;
    }>(
      `select id, status, gated_reason, next_attempt_at, attempts_count, not_after from call_intents where tenant_id = $1 and $2 = any(external_refs) and cancel_reason is distinct from 'merged' order by created_at desc limit 1`,
      [TENANT, String(orderId)],
    )
  ).rows[0];

const attemptsFor = async (intentId: string) =>
  (
    await service.query<{
      id: string;
      status: string;
      end_reason: string | null;
      answered_by: string | null;
      ai_disclosed_at: Date | null;
      recording_uri: string | null;
      engine_call_id: string | null;
    }>(
      `select id, status, end_reason, answered_by, ai_disclosed_at, recording_uri, engine_call_id from call_attempts where intent_id = $1 order by attempt_no`,
      [intentId],
    )
  ).rows;

const outcomeFor = async (attemptId: string) =>
  (
    await service.query<{
      outcome: string;
      billable: boolean;
      billable_reason: string;
      superseded: boolean;
      billed_at: Date | null;
      writeback_status: string;
    }>(
      `select outcome, billable, billable_reason, superseded, billed_at, writeback_status from call_outcomes where attempt_id = $1`,
      [attemptId],
    )
  ).rows[0];

beforeAll(async () => {
  pg = await startTestPostgres();
  redisContainer = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(redisContainer.getConnectionUrl());
  service = new RoleClient(pg.urls.service);

  await service.query(
    `insert into tenants (id, name, country, data_region, status, billing_status, billing_provider, plan_code, spend_cap_daily_paise, max_concurrency, dlt_linked_at)
     values ($1, 'Client A', 'IN', 'in', 'active', 'active', 'shopify', 'growth', 2000000, 3, now())`,
    [TENANT],
  );
  await service.query(
    `insert into integrations (id, tenant_id, kind, external_id) values ($1, $2, 'shopify', $3)`,
    [newId('integration'), TENANT, SHOP],
  );
  const useCaseId = newId('useCase');
  await service.query(
    `insert into use_cases (id, tenant_id, kind, purpose, enabled, config) values ($1, $2, 'cod_confirm', 'transactional', true, '{"defaultLocale":"hi-IN"}')`,
    [useCaseId, TENANT],
  );
  await service.query(
    `insert into scripts (id, tenant_id, use_case_id, version, locale, body, status, approved_at, disclosure_validated_at) values ($1, $2, $3, 1, 'hi-IN', $4, 'approved', now(), now())`,
    [newId('script'), TENANT, useCaseId, JSON.stringify(COD_CONFIRM_HI_IN)],
  );
  await service.query(
    `insert into numbers (id, tenant_id, e164, region, series, provider, engine, purpose_allowed, status, answer_rate_7d) values ($1, null, $2, 'IN', '10digit', 'simulator', 'simulator', array['transactional','service']::purpose[], 'active', 0.4)`,
    [newId('number'), FAKE_IN.merchant],
  );
  await service.query(
    `insert into merchant_webhooks (id, tenant_id, url, secret_ref, events) values ($1, $2, 'https://client-a.example/hooks', 'inline:whsec_e2e', array['intent.scheduled','intent.gated','call.started','call.completed','outcome.final','suppression.created'])`,
    [newId('merchantWebhook'), TENANT],
  );

  const a = createDb({ url: pg.urls.app, max: 3 });
  const s = createDb({ url: pg.urls.service, max: 3 });
  appDb = a.db;
  svcDb = s.db;
  closers = [a.close, s.close];

  publisher = memoryPublisher();
  const enginePath = engineWebhookPath(ENGINE_KEY, 'simulator', TENANT);
  // The simulator "POSTs" its webhooks to the hooks service, exactly like a vendor would.
  const registry = new EngineRegistry({
    env: {
      ENGINE_DEFAULT_IN: 'simulator',
      ENGINE_DEFAULT_US: 'simulator',
      SIMULATOR_WEBHOOK_SECRET: SIM_SECRET,
    },
    simulator: {
      now: clock.now,
      sink: async (d) => {
        const r = await hooks.inject({
          method: 'POST',
          url: enginePath,
          payload: d.rawBody,
          headers: d.headers,
        });
        if (r.statusCode !== 200 && r.statusCode !== 401)
          throw new Error(`hooks ${String(r.statusCode)}`);
      },
    },
  });
  hooks = await buildHooks({
    db: svcDb,
    publisher,
    registry,
    shopifySecretFor: () => SHOPIFY_SECRET,
    engineWebhookKey: ENGINE_KEY,
    rateLimitPerMinute: 100_000,
    logLevel: 'silent',
  });
  await hooks.ready();

  writeback = recordingWriteback();
  ctx = {
    app: appDb,
    service: svcDb,
    redis,
    registry,
    log: createLogger({ service: 'e2e', level: 'silent' }),
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
    engineWebhookKey: ENGINE_KEY,
    recordings: memoryRecordingStore(),
    shopify: writeback,
    secrets: inlineSecretResolver(),
    shopifyAdmin: { apiVersion: '2026-07' },
    razorpay: null,
    stripe: null,
    mailer: memoryMailer(),
    dashboardUrl: 'https://app.naaradh.test',
    workerId: 'e2e',
    dispatchBatch: 10,
  };
}, 240_000);

afterAll(async () => {
  await hooks.close();
  for (const c of closers) await c();
  await service.end();
  redis.disconnect();
  await redisContainer.stop();
  await pg.stop();
});

describe('happy path: COD order → confirmed, billable, written back', () => {
  let intentId: string;

  it('a COD order becomes a SCHEDULED intent with the 30-minute envelope', async () => {
    const { orderId } = await postOrder(FAKE_IN.customer);
    expect(await drain()).toEqual(['shopify.events:orders/create']);
    const intent = await intentByOrder(orderId);
    expect(intent).toMatchObject({ status: 'SCHEDULED', attempts_count: 0 });
    intentId = intent?.id ?? '';
    expect(intent?.next_attempt_at?.toISOString()).toBe(addMinutes(clock.now(), 2).toISOString());
  });

  it('the dispatcher does nothing before not_before', async () => {
    expect(await dispatchOnce(ctx)).toEqual([]);
  });

  it("gates, dials, and the engine's webhooks come back through hooks", async () => {
    advance(3);
    const outcomes = await dispatchOnce(ctx);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ kind: 'dialing' });
    const [attempt] = await attemptsFor(intentId);
    expect(attempt).toMatchObject({ status: 'DIALING' });
    expect(attempt?.engine_call_id).toMatch(/^sim_call_/);
    // Four vendor events (ringing, answered, disclosed, ended) are waiting on the bus.
    expect(publisher.messages.map((m) => m.message.topic)).toEqual([
      'call.ringing',
      'call.answered',
      'call.disclosed',
      'call.ended',
    ]);
  });

  it('results: attempt ENDED with disclosures, outcome confirmed + billable, ledger row, write-back, merchant events', async () => {
    await drain();
    const [attempt] = await attemptsFor(intentId);
    // P1-SHOP-2: finalize only SCHEDULES the write-back; the writebacks worker runs it after commit.
    expect(await outcomeFor(attempt?.id ?? '')).toMatchObject({ writeback_status: 'pending' });
    expect(await runWritebacksOnce(ctx)).toMatchObject({ claimed: 1, done: 1 });
    expect(attempt).toMatchObject({
      status: 'ENDED',
      end_reason: 'completed',
      answered_by: 'human',
    });
    expect(attempt?.ai_disclosed_at).not.toBeNull();
    expect(attempt?.recording_uri).toMatch(/^mem:\/\/recordings\//); // E-34: our store, not the vendor URL
    const outcome = await outcomeFor(attempt?.id ?? '');
    expect(outcome).toMatchObject({
      outcome: 'confirmed',
      billable: true,
      billable_reason: 'ok',
      superseded: false,
      writeback_status: 'done',
    });
    expect(outcome?.billed_at).not.toBeNull();
    const ledger = await service.query<{ kind: string; total_minor: number; ref: string }>(
      `select kind, total_minor::int as total_minor, ref from billing_ledger where tenant_id = $1`,
      [TENANT],
    );
    expect(ledger.rows).toHaveLength(1);
    // Growth includes 500 outcomes a month (SPEC §2.2, ADR-0008): the first is metered at ₹0.
    expect(ledger.rows[0]).toMatchObject({ kind: 'outcome', total_minor: 0 });
    expect(writeback.applied.at(-1)?.plan.tags).toContain('naaradh:cod-confirmed');
    expect(writeback.applied.at(-1)?.plan.cancelOrder).toBe(false);
    const intent = await intentByOrder(Number(writeback.applied.at(-1)?.orderIds[0]));
    expect(intent?.status).toBe('COMPLETED');
    const events = await service.query<{ event_type: string }>(
      `select event_type from merchant_webhook_deliveries where tenant_id = $1 order by created_at`,
      [TENANT],
    );
    expect(events.rows.map((e) => e.event_type)).toEqual(
      expect.arrayContaining([
        'intent.scheduled',
        'call.started',
        'call.completed',
        'outcome.final',
      ]),
    );
  });

  it('writeback: nothing is due twice — a second pass claims nothing', async () => {
    expect(await runWritebacksOnce(ctx)).toMatchObject({ claimed: 0 });
  });

  it('the concurrency slot was released and the engine spend recorded', async () => {
    expect(await redis.get(`conc:tenant:${TENANT}`)).toBe('0');
    expect(
      Number(await redis.get(`spend:engine:simulator:${clock.now().toISOString().slice(0, 10)}`)),
    ).toBeGreaterThan(0);
  });

  it('redelivering the same engine webhook is a no-op (E-22)', async () => {
    const before = await service.query<{ n: number }>(
      `select count(*)::int as n from call_outcomes where tenant_id = $1`,
      [TENANT],
    );
    const [attempt] = await attemptsFor(intentId);
    const events = await service.query<{ id: string }>(
      `select id from webhook_events where source = 'engine_simulator' and topic = 'call.ended' and tenant_id = $1 order by received_at limit 1`,
      [TENANT],
    );
    await handleEngineEvent(ctx, {
      webhook_event_id: events.rows[0]?.id ?? '',
      source: 'engine_simulator',
      topic: 'call.ended',
      tenant_id: TENANT,
      external_account: 'simulator',
      received_at: '',
    });
    const after = await service.query<{ n: number }>(
      `select count(*)::int as n from call_outcomes where tenant_id = $1`,
      [TENANT],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    expect((await attemptsFor(intentId))[0]?.status).toBe(attempt?.status);
  });
});

describe('retries inside the envelope, then the attempt limit', () => {
  const noAnswer = '+916000000004'; // suffix 004 → no-answer scenario
  let orderId: number;
  let intentId: string;

  it('a no-answer schedules a retry 10 minutes later', async () => {
    ({ orderId } = await postOrder(noAnswer));
    await drain();
    advance(3);
    await dispatchOnce(ctx);
    await drain();
    const intent = await intentByOrder(orderId);
    intentId = intent?.id ?? '';
    expect(intent).toMatchObject({ status: 'RETRY_SCHEDULED', attempts_count: 1 });
    expect(intent?.next_attempt_at?.toISOString()).toBe(addMinutes(clock.now(), 10).toISOString());
    const [a] = await attemptsFor(intentId);
    expect(a).toMatchObject({ status: 'NO_ANSWER' });
    expect(await outcomeFor(a?.id ?? '')).toMatchObject({
      outcome: 'no_answer',
      billable: false,
      billable_reason: 'not_human',
    });
  });

  it('the retry dials, fails again, and the third is refused by the 2-per-24h limit', async () => {
    advance(10);
    expect((await dispatchOnce(ctx))[0]).toMatchObject({ kind: 'dialing' });
    await drain();
    let intent = await intentByOrder(orderId);
    expect(intent).toMatchObject({ status: 'RETRY_SCHEDULED', attempts_count: 2 });
    advance(10);
    const third = await dispatchOnce(ctx);
    expect(third[0]).toMatchObject({ kind: 'gated', reason: 'attempts:daily' });
    intent = await intentByOrder(orderId);
    expect(intent?.status).toBe('GATED');
    expect(await attemptsFor(intentId)).toHaveLength(2);
  });
});

describe('opt-out (invariant 6, E-03)', () => {
  it('a verbal opt-out suppresses the number and blocks the next order', async () => {
    const { orderId } = await postOrder(FAKE_IN.optedOut); // suffix 010 → opt-out mid-call
    await drain();
    advance(3);
    await dispatchOnce(ctx);
    await drain();
    const intent = await intentByOrder(orderId);
    expect(intent?.status).toBe('COMPLETED');
    const [a] = await attemptsFor(intent?.id ?? '');
    expect(await outcomeFor(a?.id ?? '')).toMatchObject({ outcome: 'opt_out', billable: false });
    const sup = await service.query<{ reason: string; purpose: string }>(
      `select reason, purpose from suppressions where tenant_id = $1 and phone_hash = $2 and lifted_at is null`,
      [TENANT, hashPhone(FAKE_IN.optedOut, HASH_KEY)],
    );
    expect(sup.rows).toEqual([{ reason: 'opt_out', purpose: 'all' }]);

    const next = await postOrder(FAKE_IN.optedOut);
    await drain();
    advance(3);
    expect((await dispatchOnce(ctx))[0]).toMatchObject({
      kind: 'gated',
      reason: 'suppression:tenant',
    });
    expect((await intentByOrder(next.orderId))?.status).toBe('GATED');
  });
});

describe('cancelled while the call is live (E-40)', () => {
  it('the outcome is superseded and never billed', async () => {
    const { orderId } = await postOrder(FAKE_IN.customer);
    await drain();
    advance(3);
    await dispatchOnce(ctx);
    // Engine events are on the bus but not yet processed: the order is cancelled meanwhile.
    await postShopifyTopic('orders/cancelled', {
      id: orderId,
      cancelled_at: clock.now().toISOString(),
      cancel_reason: 'customer',
    });
    // Shopify's message queued after the engine's: process the cancellation first, as it
    // would if it arrived first, then the engine events.
    const cancel = publisher.messages.splice(
      publisher.messages.findIndex((m) => m.topic === 'shopify.events'),
      1,
    )[0];
    if (cancel !== undefined) await handleShopifyEvent(ctx, cancel.message);
    await drain();
    const intent = await intentByOrder(orderId);
    expect(intent?.status).toBe('CANCELLED');
    const [a] = await attemptsFor(intent?.id ?? '');
    expect(await outcomeFor(a?.id ?? '')).toMatchObject({
      outcome: 'outcome_superseded',
      billable: false,
      billable_reason: 'superseded',
      superseded: true,
    });
  });
});

describe('vendor failure modes (AGENTS §5.3)', () => {
  it('5xx: attempt FAILED, intent rescheduled in a minute, attempt does not count against the customer', async () => {
    const { orderId } = await postOrder('+916000000041'); // engine-5xx
    await drain();
    advance(3);
    expect((await dispatchOnce(ctx))[0]).toMatchObject({
      kind: 'engine_error',
      code: 'ENGINE_UNAVAILABLE',
    });
    const intent = await intentByOrder(orderId);
    expect(intent).toMatchObject({ status: 'SCHEDULED', attempts_count: 0 });
    expect(intent?.next_attempt_at?.toISOString()).toBe(addMinutes(clock.now(), 1).toISOString());
    expect(await redis.get('circuit_fail:simulator')).toBe('1');
    // Park it: a permanently failing vendor would otherwise re-enter every later dispatch pass.
    await service.query(
      `update call_intents set status = 'CANCELLED', next_attempt_at = null, cancel_reason = 'test' where id = $1`,
      [intent?.id],
    );
  });

  it('429: honours Retry-After and succeeds on the third try', async () => {
    const { orderId } = await postOrder('+916000000040'); // rate-limited ×2 then ok
    await drain();
    advance(3);
    const first = (await dispatchOnce(ctx)).find((o) => o.kind === 'engine_error');
    expect(first).toMatchObject({ kind: 'engine_error', code: 'RATE_LIMITED' });
    current = new Date(current.getTime() + 3_000);
    const second = (await dispatchOnce(ctx)).find((o) => o.kind === 'engine_error');
    expect(second).toMatchObject({ kind: 'engine_error', code: 'RATE_LIMITED' });
    current = new Date(current.getTime() + 3_000);
    const third = (await dispatchOnce(ctx)).find((o) => o.kind === 'dialing');
    expect(third).toBeDefined();
    await drain();
    expect((await intentByOrder(orderId))?.status).toBe('COMPLETED');
  });

  it("timeout after send: UNCERTAIN, never blindly retried; reconcile adopts the vendor's call", async () => {
    const { orderId } = await postOrder('+916000000042'); // timeout-uncertain
    await drain();
    advance(3);
    expect((await dispatchOnce(ctx)).find((o) => o.kind === 'uncertain')).toBeDefined();
    // The vendor's webhooks never reach us in this scenario.
    publisher.messages.length = 0;
    const intent = await intentByOrder(orderId);
    expect(intent?.status).toBe('IN_PROGRESS');
    let [a] = await attemptsFor(intent?.id ?? '');
    expect(a?.status).toBe('UNCERTAIN');
    // A second dispatch pass must NOT create a second attempt.
    expect(await dispatchOnce(ctx)).toEqual([]);
    const report = await reconcileOnce(ctx);
    expect(report.uncertainResolved).toBe(1);
    [a] = await attemptsFor(intent?.id ?? '');
    expect(a).toMatchObject({ status: 'ENDED', end_reason: 'completed' });
    expect(a?.engine_call_id).toMatch(/^sim_call_/);
  });
});

describe('an engine that does not sign its webhooks (invariant 9, E-23)', () => {
  it('the outcome and billing come from the FETCHED record — never from what the webhook body claims', async () => {
    const { orderId } = await postOrder('+916000000099'); // plain happy path on the simulator
    await drain();
    advance(3);
    await dispatchOnce(ctx);
    const intent = await intentByOrder(orderId);
    const [attempt] = await attemptsFor(intent?.id ?? '');

    // As an unsigned vendor would deliver it: not verified, and claiming a billable "confirmed".
    await service.query(
      `update webhook_events set signature_valid = false where tenant_id = $1 and status <> 'processed'`,
      [TENANT],
    );
    const sim = ctx.registry.get('simulator');
    const fetchCall = sim.fetchCall.bind(sim);
    let fetched = 0;
    sim.fetchCall = async (ref) => {
      fetched += 1;
      return {
        ...(await fetchCall(ref)),
        attemptId: attempt?.id ?? null,
        // What the vendor's own record says happened: the customer cancelled.
        result: {
          humanSpeechSec: 9,
          recordingUrl: null,
          transcript: null,
          extracted: { outcome: 'cancelled', cancel_reason: 'changed_mind', confidence: 0.95 },
          detectedLocale: null,
          vendorCost: null,
        },
      };
    };
    try {
      await drain();
    } finally {
      sim.fetchCall = fetchCall;
    }
    expect(fetched).toBe(1);
    expect(await outcomeFor(attempt?.id ?? '')).toMatchObject({ outcome: 'cancelled' });
  });

  it('a body that names another call than the one we dispatched is ignored and audited', async () => {
    const { orderId } = await postOrder('+916000000098');
    await drain();
    advance(3);
    await dispatchOnce(ctx);
    const intent = await intentByOrder(orderId);
    const [attempt] = await attemptsFor(intent?.id ?? '');
    await service.query(
      `update webhook_events
          set signature_valid = false,
              payload = jsonb_set(payload, '{ref,callId}', '"sim_call_someone_elses"')
        where tenant_id = $1 and status <> 'processed' and topic = 'call.ended'`,
      [TENANT],
    );
    await drain();
    expect(await outcomeFor(attempt?.id ?? '')).toBeUndefined();
    const audited = await service.query<{ n: number }>(
      `select count(*)::int as n from audit_log where tenant_id = $1 and action = 'results.unsigned_mismatch' and target_id = $2`,
      [TENANT, attempt?.id ?? ''],
    );
    expect(audited.rows[0]?.n).toBe(1);
  });
});

describe('uninstall (E-48)', () => {
  it('pauses the tenant and cancels everything waiting', async () => {
    const { orderId } = await postOrder(FAKE_IN.customerAlt);
    await drain();
    await service.query(
      `insert into shopify_sessions (id, shop, secret_ciphertext, secret_iv, secret_tag) values ($1, $2, '\\x00', '\\x00', '\\x00')`,
      [`offline_${SHOP}`, SHOP],
    );
    await postShopifyTopic('app/uninstalled', { id: 1, domain: SHOP });
    await drain();
    expect((await intentByOrder(orderId))?.status).toBe('CANCELLED');
    const t = await service.query<{ status: string; paused_reason: string }>(
      `select status, paused_reason from tenants where id = $1`,
      [TENANT],
    );
    expect(t.rows[0]).toEqual({ status: 'paused', paused_reason: 'app/uninstalled' });
    const i = await service.query<{ status: string; purge_due_at: Date | null }>(
      `select status, purge_due_at from integrations where tenant_id = $1`,
      [TENANT],
    );
    expect(i.rows[0]?.status).toBe('uninstalled');
    expect(i.rows[0]?.purge_due_at).not.toBeNull();
    // The store's Admin API session is deleted with the install.
    expect(
      (await service.query(`select 1 from shopify_sessions where shop = $1`, [SHOP])).rowCount,
    ).toBe(0);
  });
});

describe('merchant webhook deliveries', () => {
  it('signs and delivers, backs off on failure, and dead-letters after 5', async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const ok = await deliverOnce(ctx, async (url, body, headers) => {
      seen.push({ url, headers, body });
      return { status: 200 };
    });
    expect(ok.delivered).toBeGreaterThan(0);
    expect(seen[0]?.headers['x-naaradh-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(seen[0]?.body).not.toContain(FAKE_IN.customer);
    expect(seen[0]?.body).not.toContain('Asha');

    await service.query(
      // Due at the TEST clock, not the wall clock: the two drift apart as earlier cases advance `current`.
      `insert into merchant_webhook_deliveries (id, tenant_id, webhook_id, event_type, event_id, payload, status, next_attempt_at) select $1, tenant_id, id, 'outcome.final', 'evt-dead', '{"id":"evt-dead"}', 'pending', $3 from merchant_webhooks where tenant_id = $2 limit 1`,
      [newId('delivery'), TENANT, current],
    );
    for (let i = 0; i < 5; i += 1) {
      const r = await deliverOnce(ctx, async () => ({ status: 503 }));
      expect(r.delivered).toBe(0);
      const row = await service.query<{
        status: string;
        attempts: number;
        next_attempt_at: Date | null;
      }>(
        `select status, attempts, next_attempt_at from merchant_webhook_deliveries where event_id = 'evt-dead'`,
      );
      expect(row.rows[0]?.attempts).toBe(i + 1);
      if (i < 4) {
        expect(row.rows[0]?.status).toBe('failed');
        expect(row.rows[0]?.next_attempt_at).not.toBeNull();
        current = new Date((row.rows[0]?.next_attempt_at ?? current).getTime() + 1000);
      } else {
        expect(row.rows[0]).toMatchObject({ status: 'dead', next_attempt_at: null });
      }
    }
  });
});

describe('Shopify write-back queue (P1-SHOP-2)', () => {
  it('a transient store failure is retried with backoff and converges; a superseded outcome is never written', async () => {
    // Earlier scenarios left their write-backs queued: flush them.
    while ((await runWritebacksOnce(ctx)).claimed > 0) {
      /* drain */
    }
    const superseded = await service.query<{ writeback_status: string }>(
      `select writeback_status from call_outcomes where tenant_id = $1 and superseded`,
      [TENANT],
    );
    expect(superseded.rows.length).toBeGreaterThan(0);
    expect(new Set(superseded.rows.map((r) => r.writeback_status))).toEqual(new Set(['skipped']));
    const stuck = await service.query(
      `select 1 from call_outcomes where tenant_id = $1 and writeback_status in ('pending','failed')`,
      [TENANT],
    );
    expect(stuck.rows).toHaveLength(0);

    // The uninstall scenario (E-48) paused the tenant: reinstall for this one.
    await service.query(
      `update tenants set status = 'active', paused_at = null, paused_reason = null, uninstalled_at = null where id = $1`,
      [TENANT],
    );
    await service.query(
      `update integrations set status = 'active', uninstalled_at = null, purge_due_at = null where tenant_id = $1`,
      [TENANT],
    );
    await redis.del(`conc:tenant:${TENANT}`, 'conc:engine:simulator');

    const { orderId } = await postOrder(FAKE_IN.customer);
    await drain();
    advance(3);
    await dispatchOnce(ctx);
    await drain();
    const intent = await intentByOrder(orderId);
    const [a] = await attemptsFor(intent?.id ?? '');
    const before = writeback.applied.length;

    writeback.failNext = 1;
    expect(await runWritebacksOnce(ctx)).toMatchObject({ claimed: 1, retrying: 1 });
    const failed = (
      await service.query<{
        writeback_status: string;
        writeback_attempts: number;
        writeback_next_at: Date | null;
        writeback_error: string;
      }>(
        `select writeback_status, writeback_attempts, writeback_next_at, writeback_error from call_outcomes where attempt_id = $1`,
        [a?.id],
      )
    ).rows[0];
    expect(failed).toMatchObject({ writeback_status: 'failed', writeback_attempts: 1 });
    expect(failed?.writeback_error).toContain('simulated Shopify failure');
    expect(failed?.writeback_next_at?.toISOString()).toBe(addMinutes(clock.now(), 2).toISOString());

    // Not due yet: nothing happens.
    expect(await runWritebacksOnce(ctx)).toMatchObject({ claimed: 0 });
    advance(3);
    expect(await runWritebacksOnce(ctx)).toMatchObject({ claimed: 1, done: 1 });
    expect(writeback.applied.length).toBe(before + 1);
    expect(writeback.applied.at(-1)?.orderIds).toEqual([String(orderId)]);
    const done = (
      await service.query<{
        writeback_status: string;
        writeback_attempts: number;
        writeback_next_at: Date | null;
      }>(
        `select writeback_status, writeback_attempts, writeback_next_at from call_outcomes where attempt_id = $1`,
        [a?.id],
      )
    ).rows[0];
    expect(done).toMatchObject({
      writeback_status: 'done',
      writeback_attempts: 2,
      writeback_next_at: null,
    });
  });
});
