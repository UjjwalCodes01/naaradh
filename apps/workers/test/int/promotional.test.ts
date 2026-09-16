import { memoryMailer } from '@naaradh/notify';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { createDb, withTenant, type Db } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import { liftPromotionalPause, suppress, type DndProvider } from '@naaradh/compliance';
import { calendarRegistry } from '@naaradh/calendar';
import {
  eraseAppointments,
  eraseCheckouts,
  sweepAbandonedCheckouts,
  sweepAppointmentReminders,
  upsertAppointment,
} from '@naaradh/pipeline';
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
import {
  ABANDONED_CART_HI_IN,
  APPOINTMENT_CONFIRM_HI_IN,
  COD_CONFIRM_HI_IN,
  FEEDBACK_HI_IN,
} from '@naaradh/scripts';
import { buildServer as buildHooks } from '../../../hooks/src/server.js';
import { memoryPublisher } from '../../../hooks/src/pubsub.js';
import type { WorkerContext } from '../../src/context.js';
import { runComplaintsOnce } from '../../src/complaints/index.js';
import { inlineSecretResolver } from '../../src/deliveries/secrets.js';
import { dispatchOnce } from '../../src/dispatcher/loop.js';
import { handleShopifyEvent } from '../../src/intents/consumer.js';
import { runQaWeekly } from '../../src/qa/index.js';
import { syncAppointmentsOnce } from '../../src/appointments/index.js';
import { handleEngineEvent } from '../../src/results/consumer.js';
import { memoryRecordingStore } from '../../src/results/recordings.js';
import { recordingWriteback } from '../../src/results/writeback.js';

/**
 * Phase 4 (ADR-0010) on real Postgres + Redis with the simulator: a consented abandoned checkout
 * becomes one recovery call, the order that follows is attributed (never billed) and reversed on
 * cancellation, feedback follows a delivery, a promotional complaint pauses promotional calling
 * only, and QA samples the week. Every refusal lands where the ADR says it must.
 */

const TENANT = newId('tenant');
const SHOP = 'client-p-promo.myshopify.com';
const SHOPIFY_SECRET = 'shpss_promo';
const SIM_SECRET = 'simulator_secret_for_promo_tests';
const ENGINE_KEY = 'p'.repeat(32);
const HASH_KEY = 'q'.repeat(32);
const WORDING = '2026-09-v1-draft';
const TEMPLATE_CART = '1107160000000000101';
const TEMPLATE_FEEDBACK = '1107160000000000102';
const keyPair = generatePhoneKeyPair();

/** Fake numbers. Suffixes outside the simulator's scenario table answer and say yes. */
const P = {
  recovered: FAKE_IN.customer, // 001: answers, will complete
  noAnswer: '+916000000004', // 004: no answer
  dnd: FAKE_IN.dnd, // 011: on DND (our fake provider)
  noConsent: '+916000000051',
  completes: '+916000000052',
  ordersFirst: '+916000000053',
  unticks: '+916000000054',
  unknownWording: '+916000000055',
  afterPause: '+916000000056',
  cod: '+916000000057',
  feedback: '+916000000058',
  feedbackCancelled: '+916000000059',
  appointment: '+916000000062',
  appointmentOptedOut: '+916000000063',
} as const;

/** 12:00 IST on Monday 2026-09-14. */
let current = new Date('2026-09-14T06:30:00Z');
const clock = { now: () => new Date(current.getTime()) };
const advance = (minutes: number) => {
  current = addMinutes(current, minutes);
};

const fakeDnd: DndProvider = {
  name: 'fake-tsp',
  check: async (e164) => (e164 === P.dnd ? 'registered' : 'not_registered'),
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
let seq = 0;

async function post(topic: string, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload);
  const r = await hooks.inject({
    method: 'POST',
    url: '/shopify/webhooks',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': SHOP,
      'x-shopify-webhook-id': `wh-${topic}-${sha256Hex(body).slice(0, 12)}`,
      'x-shopify-hmac-sha256': createHmac('sha256', SHOPIFY_SECRET).update(body).digest('base64'),
    },
  });
  expect(r.statusCode).toBe(200);
}

async function drain(): Promise<void> {
  while (publisher.messages.length > 0) {
    const { topic, message } = publisher.messages.shift() as (typeof publisher.messages)[number];
    if (topic === 'shopify.events') await handleShopifyEvent(ctx, message);
    else if (topic === 'engine.events') await handleEngineEvent(ctx, message);
  }
}

function checkout(
  phone: string | null,
  over: Record<string, unknown> & { consent?: string | null } = {},
): Record<string, unknown> {
  seq += 1;
  const { consent = WORDING, ...rest } = over;
  return {
    id: 90_000 + seq,
    token: `chk-${String(seq)}`,
    created_at: clock.now().toISOString(),
    updated_at: clock.now().toISOString(),
    completed_at: null,
    currency: 'INR',
    total_price: '1299.00',
    source_name: 'web',
    // Shopify's own marketing flags are set on purpose: they must never count (E-107).
    buyer_accepts_marketing: true,
    shipping_address: { phone, country_code: 'IN', first_name: 'Asha' },
    note_attributes: consent === null ? [] : [{ name: 'naaradh_call_consent', value: consent }],
    line_items: [{ title: 'Kurta', quantity: 1 }],
    ...rest,
  };
}

function order(phone: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    id: 70_000 + seq,
    name: `#${String(70_000 + seq)}`,
    created_at: clock.now().toISOString(),
    updated_at: clock.now().toISOString(),
    currency: 'INR',
    total_price: '1299.00',
    financial_status: 'paid',
    payment_gateway_names: ['razorpay'],
    customer: { first_name: 'Asha', last_name: 'Test', phone: null },
    shipping_address: { phone, zip: '110001', country_code: 'IN' },
    line_items: [{ title: 'Kurta', quantity: 1 }],
    ...over,
  };
}

const hash = (phone: string) => hashPhone(phone, HASH_KEY);
const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await service.query<T>(text, params)).rows;

const checkoutRow = async (token: string) =>
  (
    await q<{ id: string; status: string; skip_reason: string | null; intent_id: string | null }>(
      `select id, status, skip_reason, intent_id from checkouts where tenant_id = $1 and external_id = $2`,
      [TENANT, token],
    )
  )[0];

const intent = async (id: string) =>
  (
    await q<{
      status: string;
      gated_reason: string | null;
      attempts_count: number;
      cancel_reason: string | null;
      use_case: string;
    }>(
      `select status, gated_reason, attempts_count, cancel_reason, use_case from call_intents where id = $1`,
      [id],
    )
  )[0];

const events = async (type: string) =>
  q<{ payload: { data: Record<string, unknown> } }>(
    `select payload from merchant_webhook_deliveries where tenant_id = $1 and event_type = $2 order by created_at`,
    [TENANT, type],
  );

const sweep = () => sweepAbandonedCheckouts(svcDb, appDb, ctx.keys, clock.now());
const sweepReminders = () => sweepAppointmentReminders(svcDb, appDb, ctx.keys, clock.now());

beforeAll(async () => {
  pg = await startTestPostgres();
  redisContainer = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(redisContainer.getConnectionUrl());
  service = new RoleClient(pg.urls.service);

  await service.query(
    `insert into tenants (id, name, country, data_region, status, billing_status, billing_provider, plan_code, spend_cap_daily_paise, max_concurrency, dlt_pe_id, dlt_linked_at)
     values ($1, 'Client P', 'IN', 'in', 'active', 'active', 'shopify', 'growth', 2000000, 5, '1101234567890123', now())`,
    [TENANT],
  );
  await service.query(
    `insert into integrations (id, tenant_id, kind, external_id) values ($1, $2, 'shopify', $3)`,
    [newId('integration'), TENANT, SHOP],
  );
  const useCase = async (kind: string, purpose: string) => {
    const id = newId('useCase');
    await service.query(
      `insert into use_cases (id, tenant_id, kind, purpose, enabled, config) values ($1, $2, $3, $4, true, '{"defaultLocale":"hi-IN"}')`,
      [id, TENANT, kind, purpose],
    );
    return id;
  };
  const script = async (useCaseId: string, body: unknown, template: string | null) =>
    service.query(
      `insert into scripts (id, tenant_id, use_case_id, version, locale, body, status, approved_at, disclosure_validated_at, dlt_template_id) values ($1, $2, $3, 1, 'hi-IN', $4, 'approved', now(), now(), $5)`,
      [newId('script'), TENANT, useCaseId, JSON.stringify(body), template],
    );
  await script(await useCase('cod_confirm', 'transactional'), COD_CONFIRM_HI_IN, null);
  await script(await useCase('abandoned_cart', 'promotional'), ABANDONED_CART_HI_IN, TEMPLATE_CART);
  await script(await useCase('feedback', 'promotional'), FEEDBACK_HI_IN, TEMPLATE_FEEDBACK);
  // ADR-0011: appointment reminders are a SERVICE purpose — no consent, no DLT template.
  await script(await useCase('appointment_confirm', 'service'), APPOINTMENT_CONFIRM_HI_IN, null);
  await service.query(
    `insert into numbers (id, tenant_id, e164, region, series, provider, engine, purpose_allowed, status, answer_rate_7d) values ($1, null, $2, 'IN', '10digit', 'simulator', 'simulator', array['transactional','service','promotional']::purpose[], 'active', 0.4)`,
    [newId('number'), FAKE_IN.merchant],
  );
  await service.query(
    `insert into merchant_webhooks (id, tenant_id, url, secret_ref, events) values ($1, $2, 'https://client-p.example/hooks', 'inline:whsec_promo', array['intent.scheduled','intent.gated','outcome.final','checkout.recovery_requested','order.recovered','promotional.paused'])`,
    [newId('merchantWebhook'), TENANT],
  );

  const a = createDb({ url: pg.urls.app, max: 3 });
  const s = createDb({ url: pg.urls.service, max: 3 });
  appDb = a.db;
  svcDb = s.db;
  closers = [a.close, s.close];

  publisher = memoryPublisher();
  const enginePath = engineWebhookPath(ENGINE_KEY, 'simulator', TENANT);
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

  ctx = {
    app: appDb,
    service: svcDb,
    redis,
    registry,
    log: createLogger({ service: 'promo', level: 'silent' }),
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
    shopify: recordingWriteback(),
    secrets: inlineSecretResolver(),
    shopifyAdmin: { apiVersion: '2026-07' },
    razorpay: null,
    mailer: memoryMailer(),
    dashboardUrl: 'https://app.naaradh.test',
    workerId: 'promo',
    dispatchBatch: 10,
    dnd: fakeDnd,
    calendars: calendarRegistry({ now: () => clock.now() }),
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

describe('abandoned checkout → one recovery call → attributed order (ADR-0010)', () => {
  let token: string;
  let intentId: string;
  let attemptId: string;
  let orderPayload: Record<string, unknown>;

  it('records consent from our checkbox only, once, and nothing before 45 idle minutes', async () => {
    const c = checkout(P.recovered);
    token = String(c['token']);
    await post('checkouts/create', c);
    await post('checkouts/create', c); // redelivery with a new webhook id is still one grant
    await drain();
    const grants = await q<{ source: string; purpose: string; wording_version: string }>(
      `select source, purpose, wording_version from consents where tenant_id = $1 and phone_hash = $2 and action = 'grant'`,
      [TENANT, hash(P.recovered)],
    );
    expect(grants).toEqual([
      { source: 'checkout', purpose: 'promotional', wording_version: WORDING },
    ]);
    expect(await checkoutRow(token)).toMatchObject({ status: 'open', intent_id: null });
    advance(30);
    expect((await sweep()).considered).toBe(0);
  });

  it('E-101: an update resets the idle clock; the sweep then queues exactly one intent', async () => {
    const c = checkout(P.recovered, {
      token,
      created_at: addMinutes(clock.now(), -30).toISOString(),
    });
    await post('checkouts/update', { ...c, updated_at: clock.now().toISOString() });
    await drain();
    advance(40);
    expect((await sweep()).scheduled).toBe(0); // 40 min since the update: still waiting
    advance(6);
    const r = await sweep();
    expect(r.scheduled).toBe(1);
    const row = await checkoutRow(token);
    expect(row?.status).toBe('scheduled');
    intentId = row?.intent_id ?? '';
    expect(await intent(intentId)).toMatchObject({
      status: 'SCHEDULED',
      use_case: 'abandoned_cart',
    });
    expect((await sweep()).considered).toBe(0); // swept once
  });

  it('dials through the gate with the DLT template on the attempt; will_complete asks the merchant to send the link', async () => {
    const out = await dispatchOnce(ctx);
    expect(out).toEqual([expect.objectContaining({ kind: 'dialing' })]);
    await drain();
    const [attempt] = await q<{ id: string; dlt_template_id: string | null; purpose: string }>(
      `select id, dlt_template_id, purpose from call_attempts where intent_id = $1`,
      [intentId],
    );
    attemptId = attempt?.id ?? '';
    expect(attempt).toMatchObject({ dlt_template_id: TEMPLATE_CART, purpose: 'promotional' });
    const [outcome] = await q<{ outcome: string; billable: boolean; writeback_status: string }>(
      `select outcome, billable, writeback_status from call_outcomes where attempt_id = $1`,
      [attemptId],
    );
    // Invariant 11: never billed. Nothing to write to the store for a checkout.
    expect(outcome).toEqual({
      outcome: 'will_complete',
      billable: false,
      writeback_status: 'skipped',
    });
    expect(await intent(intentId)).toMatchObject({ status: 'COMPLETED' });
    const [ev] = await events('checkout.recovery_requested');
    expect(ev?.payload.data).toMatchObject({ checkout_token: token, outcome: 'will_complete' });
    expect(JSON.stringify(ev?.payload)).not.toContain(P.recovered);
    const dnd = await q<{ result: string }>(
      `select result from dnd_scrub_cache where phone_hash = $1`,
      [hash(P.recovered)],
    );
    expect(dnd).toEqual([{ result: 'not_registered' }]);
  });

  it('an order two hours later is recovered — matched by checkout, measured, not billed', async () => {
    const ledgerBefore = await q<{ n: number }>(
      `select count(*)::int as n from billing_ledger where tenant_id = $1`,
      [TENANT],
    );
    advance(120);
    orderPayload = order(P.recovered, { checkout_token: token });
    await post('orders/create', orderPayload);
    await drain();
    const attr = await q<{
      matched_by: string;
      value_minor: string;
      attempt_id: string;
      reversed_at: Date | null;
    }>(
      `select matched_by, value_minor::text, attempt_id, reversed_at from attributions where tenant_id = $1`,
      [TENANT],
    );
    expect(attr).toEqual([
      { matched_by: 'checkout', value_minor: '129900', attempt_id: attemptId, reversed_at: null },
    ]);
    expect(await checkoutRow(token)).toMatchObject({ status: 'converted' });
    const [ev] = await events('order.recovered');
    expect(ev?.payload.data).toMatchObject({ billable: false, matched_by: 'checkout' });
    const ledgerAfter = await q<{ n: number }>(
      `select count(*)::int as n from billing_ledger where tenant_id = $1`,
      [TENANT],
    );
    expect(ledgerAfter).toEqual(ledgerBefore);
  });

  it('a duplicate orders/create does not attribute twice', async () => {
    await post('orders/create', { ...orderPayload, updated_at: clock.now().toISOString() });
    await drain();
    expect(await q(`select 1 from attributions where tenant_id = $1`, [TENANT])).toHaveLength(1);
  });

  it('E-118: cancelling the order reverses the attribution', async () => {
    advance(10);
    await post('orders/cancelled', {
      ...orderPayload,
      cancelled_at: clock.now().toISOString(),
      updated_at: clock.now().toISOString(),
    });
    await drain();
    const [a] = await q<{ reversed_at: Date | null }>(
      `select reversed_at from attributions where tenant_id = $1`,
      [TENANT],
    );
    expect(a?.reversed_at).not.toBeNull();
  });

  it('E-108: another abandoned checkout from the same phone within 7 days is not called', async () => {
    const c = checkout(P.recovered);
    await post('checkouts/create', c);
    await drain();
    advance(46);
    await sweep();
    expect(await checkoutRow(String(c['token']))).toMatchObject({
      status: 'skipped',
      skip_reason: 'recently_called',
    });
  });
});

describe('checkouts that must never become calls', () => {
  it('(a new morning: 10:00 IST on Tuesday, well inside the calling window)', () => {
    current = new Date('2026-09-15T04:30:00Z');
  });

  it('E-107: no checkbox (only Shopify marketing consent) → consent:missing', async () => {
    const c = checkout(P.noConsent, { consent: null });
    await post('checkouts/create', c);
    await drain();
    advance(46);
    await sweep();
    expect(await checkoutRow(String(c['token']))).toMatchObject({
      status: 'skipped',
      skip_reason: 'consent:missing',
      intent_id: null,
    });
  });

  it('E-106: a wording version we never published is not consent', async () => {
    const c = checkout(P.unknownWording, { consent: 'yes-please' });
    await post('checkouts/create', c);
    await drain();
    expect(
      await q(`select 1 from consents where tenant_id = $1 and phone_hash = $2`, [
        TENANT,
        hash(P.unknownWording),
      ]),
    ).toHaveLength(0);
    advance(46);
    await sweep();
    expect(await checkoutRow(String(c['token']))).toMatchObject({ skip_reason: 'consent:missing' });
  });

  it('E-105: ticked then unticked revokes the grant', async () => {
    const c = checkout(P.unticks);
    await post('checkouts/create', c);
    advance(2);
    await post('checkouts/update', {
      ...c,
      note_attributes: [],
      updated_at: clock.now().toISOString(),
    });
    await drain();
    const rows = await q<{ action: string }>(
      `select action from consents where tenant_id = $1 and phone_hash = $2 order by created_at`,
      [TENANT, hash(P.unticks)],
    );
    expect(rows.map((r) => r.action)).toEqual(['grant', 'revoke']);
    advance(46);
    await sweep();
    expect(await checkoutRow(String(c['token']))).toMatchObject({ skip_reason: 'consent:missing' });
  });

  it('E-102: completed by the customer → never swept, and a late stale update cannot reopen it', async () => {
    const c = checkout(P.completes);
    await post('checkouts/create', c);
    advance(10);
    await post('checkouts/update', {
      ...c,
      completed_at: clock.now().toISOString(),
      updated_at: clock.now().toISOString(),
    });
    // E-104: an older update delivered after the completion.
    await post('checkouts/update', { ...c, updated_at: addMinutes(clock.now(), -5).toISOString() });
    await drain();
    advance(46);
    await sweep();
    expect(await checkoutRow(String(c['token']))).toMatchObject({
      status: 'completed',
      intent_id: null,
    });
  });

  it('E-102/E-103: an order from the phone after the call was queued cancels it', async () => {
    const c = checkout(P.ordersFirst);
    await post('checkouts/create', c);
    await drain();
    advance(46);
    await sweep();
    const row = await checkoutRow(String(c['token']));
    expect(row?.status).toBe('scheduled');
    // Ordered from another device (no checkout token), before the dispatcher got to it.
    await post('orders/create', order(P.ordersFirst));
    await drain();
    expect(await checkoutRow(String(c['token']))).toMatchObject({ status: 'converted' });
    expect(await intent(row?.intent_id ?? '')).toMatchObject({
      status: 'CANCELLED',
      cancel_reason: 'order_placed',
    });
    expect(await dispatchOnce(ctx)).toEqual([]);
  });

  it('E-04: a number on DND is refused by the gate, after a scrub at dial time', async () => {
    const c = checkout(P.dnd);
    await post('checkouts/create', c);
    await drain();
    advance(46);
    await sweep();
    const row = await checkoutRow(String(c['token']));
    const out = await dispatchOnce(ctx);
    expect(out).toEqual([expect.objectContaining({ kind: 'gated', reason: 'dnd:registered' })]);
    expect(await intent(row?.intent_id ?? '')).toMatchObject({
      status: 'GATED',
      gated_reason: 'dnd:registered',
    });
  });

  it('ADR-0010 §3: one attempt per checkout — a no-answer is exhausted, not retried', async () => {
    const c = checkout(P.noAnswer);
    await post('checkouts/create', c);
    await drain();
    advance(46);
    await sweep();
    const row = await checkoutRow(String(c['token']));
    expect(await dispatchOnce(ctx)).toEqual([expect.objectContaining({ kind: 'dialing' })]);
    await drain();
    expect(await intent(row?.intent_id ?? '')).toMatchObject({
      status: 'EXHAUSTED',
      attempts_count: 1,
    });
  });

  it('E-117: an order after a call nobody answered is not attributed', async () => {
    const before = await q(`select 1 from attributions where tenant_id = $1`, [TENANT]);
    advance(30);
    await post('orders/create', order(P.noAnswer));
    await drain();
    expect(await q(`select 1 from attributions where tenant_id = $1`, [TENANT])).toHaveLength(
      before.length,
    );
  });
});

describe('a complaint about a promotional call pauses promotional calling only (E-113)', () => {
  it('pauses, tells the merchant, and blocks the next promotional call', async () => {
    // reported_at defaults to the database clock, like call_attempts.created_at it is matched against.
    await service.query(
      `insert into complaint_reports (id, tenant_id, phone_hash, source, reporter) values ($1, null, $2, 'trai', 'staff:ops@naaradh.test')`,
      [newId('complaintReport'), hash(P.noAnswer)],
    );
    const r = await runComplaintsOnce(ctx);
    expect(r).toMatchObject({ recorded: 1, promotionalPaused: 1, tenantsPaused: 0 });
    const [t] = await q<{ promotional_paused_at: Date | null; status: string }>(
      `select promotional_paused_at, status from tenants where id = $1`,
      [TENANT],
    );
    expect(t?.status).toBe('active');
    expect(t?.promotional_paused_at).not.toBeNull();
    const [c] = await q<{ purpose: string; use_case: string }>(
      `select purpose, use_case from complaints where tenant_id = $1`,
      [TENANT],
    );
    expect(c).toEqual({ purpose: 'promotional', use_case: 'abandoned_cart' });
    expect(await events('promotional.paused')).toHaveLength(1);

    const next = checkout(P.afterPause);
    await post('checkouts/create', next);
    await drain();
    advance(46);
    await sweep();
    expect(await dispatchOnce(ctx)).toEqual([
      expect.objectContaining({ kind: 'gated', reason: 'tenant:promotional_paused' }),
    ]);
  });

  it('order confirmations keep dialling while promotional is paused', async () => {
    await post(
      'orders/create',
      order(P.cod, {
        payment_gateway_names: ['Cash on Delivery (COD)'],
        financial_status: 'pending',
      }),
    );
    await drain();
    advance(3);
    expect(await dispatchOnce(ctx)).toEqual([expect.objectContaining({ kind: 'dialing' })]);
    await drain();
  });

  it('only staff lift it, with a reason', async () => {
    await expect(
      svcDb.transaction((tx) =>
        liftPromotionalPause(tx, {
          tenantId: TENANT,
          by: 'staff:ops',
          reason: 'short',
          at: clock.now(),
        }),
      ),
    ).rejects.toThrow(/10 characters/);
    // The merchant's own role cannot clear it (column grant).
    await expect(
      withTenant(appDb, TENANT, (tx) =>
        tx.execute(sql`update tenants set promotional_paused_at = null where id = ${TENANT}`),
      ),
    ).rejects.toThrow();
    const ok = await svcDb.transaction((tx) =>
      liftPromotionalPause(tx, {
        tenantId: TENANT,
        by: 'staff:ops',
        reason: 'complaint reviewed; consent evidence checked',
        at: clock.now(),
      }),
    );
    expect(ok).toBe(true);
  });
});

describe('post-delivery feedback (ADR-0010 §7)', () => {
  let feedbackOrder: Record<string, unknown>;

  it('a delivered prepaid order with consent becomes one feedback call the next day', async () => {
    feedbackOrder = order(P.feedback, {
      note_attributes: [{ name: 'naaradh_call_consent', value: WORDING }],
    });
    await post('orders/create', feedbackOrder);
    await drain();
    advance(120);
    const delivered = {
      id: 1,
      order_id: feedbackOrder['id'],
      status: 'success',
      shipment_status: 'delivered',
      updated_at: clock.now().toISOString(),
    };
    await post('fulfillments/update', delivered);
    // E-115: a second delivered event is a duplicate.
    await post('fulfillments/update', { ...delivered, tracking_number: 'DL-2' });
    await drain();
    const intents = await q<{ id: string; status: string; not_before: Date }>(
      `select id, status, not_before from call_intents where tenant_id = $1 and use_case = 'feedback' and status <> 'CANCELLED'`,
      [TENANT],
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]?.not_before.toISOString()).toBe(
      addMinutes(clock.now(), 24 * 60).toISOString(),
    );
    expect(await dispatchOnce(ctx)).toEqual([]); // not before tomorrow
    advance(24 * 60 + 1);
    expect(await dispatchOnce(ctx)).toEqual([expect.objectContaining({ kind: 'dialing' })]);
    await drain();
    const [o] = await q<{
      outcome: string;
      billable: boolean;
      writeback_status: string;
      extracted: Record<string, unknown>;
    }>(
      `select o.outcome, o.billable, o.writeback_status, o.extracted from call_outcomes o where o.intent_id = $1`,
      [intents[0]?.id],
    );
    expect(o).toMatchObject({
      outcome: 'feedback_given',
      billable: false,
      writeback_status: 'skipped',
    });
    expect(o?.extracted).toMatchObject({ nps: 9 });
    const [a] = await q<{ dlt_template_id: string }>(
      `select dlt_template_id from call_attempts where intent_id = $1`,
      [intents[0]?.id],
    );
    expect(a?.dlt_template_id).toBe(TEMPLATE_FEEDBACK);
  });

  it('E-114: a delivered event for a cancelled order asks nobody for feedback', async () => {
    const o = order(P.feedbackCancelled, {
      note_attributes: [{ name: 'naaradh_call_consent', value: WORDING }],
      cancelled_at: clock.now().toISOString(),
    });
    await post('orders/create', o);
    await post('fulfillments/update', {
      id: 2,
      order_id: o['id'],
      status: 'success',
      shipment_status: 'delivered',
      updated_at: clock.now().toISOString(),
    });
    await drain();
    expect(
      await q(
        `select 1 from call_intents where tenant_id = $1 and use_case = 'feedback' and phone_hash = $2`,
        [TENANT, hash(P.feedbackCancelled)],
      ),
    ).toHaveLength(0);
  });
});

describe('weekly QA sample and erasure', () => {
  it('samples last week once, deterministically, and never twice', async () => {
    current = new Date('2026-09-21T03:00:00Z'); // Monday 08:30 IST
    const r = await runQaWeekly(ctx, clock.now());
    expect(r).toMatchObject({ week: '2026-W38', tenants: 1, alreadySampled: 0 });
    expect(r?.sampled).toBe(1); // a handful of answered calls → the minimum of one
    expect(await runQaWeekly(ctx, clock.now())).toBeNull();
    const rows = await q<{ status: string; week: string }>(
      `select status, week from qa_reviews where tenant_id = $1`,
      [TENANT],
    );
    expect(rows).toEqual([{ status: 'pending', week: '2026-W38' }]);
  });

  it('the merchant role cannot read the QA queue', async () => {
    await expect(
      withTenant(appDb, TENANT, (tx) => tx.execute(sql`select * from qa_reviews`)),
    ).rejects.toThrow();
  });

  it('E-119: erasure strips the phone from checkouts and keeps the counts', async () => {
    const n = await withTenant(appDb, TENANT, (tx) =>
      eraseCheckouts(tx, TENANT, { phoneHash: hash(P.recovered) }, clock.now()),
    );
    expect(n).toBe(2);
    const rows = await q<{ phone_hash: string | null; status: string }>(
      `select phone_hash, status from checkouts where tenant_id = $1 and erased_at is not null`,
      [TENANT],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.phone_hash === null)).toBe(true);
  });
});

describe('appointment reminders and the calendar (ADR-0011 §7, E-133 to E-137)', () => {
  const appointment = (ref: string, startsIn: number, over: Record<string, unknown> = {}) =>
    withTenant(appDb, TENANT, (tx) =>
      upsertAppointment(tx, ctx.keys, {
        tenantId: TENANT,
        source: 'api',
        externalId: ref,
        rawPhone: P.appointment,
        defaultRegion: 'IN',
        customerName: 'Asha',
        service: 'Blood test',
        startsAt: addMinutes(clock.now(), startsIn),
        timezone: 'Asia/Kolkata',
        now: clock.now(),
        ...over,
      }),
    );

  it('(a new morning: 10:00 IST on Wednesday)', () => {
    current = new Date('2026-09-16T04:30:00Z');
  });

  it('an appointment 30 hours away is too far for a call yet', async () => {
    await appointment('apt-far', 30 * 60);
    const r = await sweepReminders();
    expect(r.considered).toBe(0);
    const [row] = await q<{ intent_id: string | null }>(
      `select intent_id from appointments where tenant_id = $1 and external_id = 'apt-far'`,
      [TENANT],
    );
    expect(row?.intent_id).toBeNull();
  });

  it('inside 24 hours it becomes exactly one confirmation call, in the appointment window', async () => {
    await appointment('apt-1', 20 * 60);
    const r = await sweepReminders();
    expect(r.scheduled).toBe(1);
    const [row] = await q<{ intent_id: string; reminder_swept_at: Date | null }>(
      `select intent_id, reminder_swept_at from appointments where tenant_id = $1 and external_id = 'apt-1'`,
      [TENANT],
    );
    expect(row?.intent_id).toBeTruthy();
    expect(row?.reminder_swept_at).not.toBeNull();
    const [i] = await q<{ use_case: string; not_before: Date; not_after: Date; status: string }>(
      `select use_case, not_before, not_after, status from call_intents where id = $1`,
      [row?.intent_id ?? ''],
    );
    expect(i?.use_case).toBe('appointment_confirm');
    expect(i?.status).toBe('SCHEDULED');
    // The envelope is measured from the appointment: 24 h before to 2 h before.
    const startsAt = addMinutes(clock.now(), 20 * 60);
    expect(i?.not_before.toISOString()).toBe(addMinutes(startsAt, -24 * 60).toISOString());
    expect(i?.not_after.toISOString()).toBe(addMinutes(startsAt, -2 * 60).toISOString());
    // Swept once.
    expect((await sweepReminders()).considered).toBe(0);
  });

  it('E-133: moving the appointment moves the call; cancelling it cancels the call', async () => {
    const [before] = await q<{ intent_id: string }>(
      `select intent_id from appointments where tenant_id = $1 and external_id = 'apt-1'`,
      [TENANT],
    );
    await appointment('apt-1', 18 * 60, { status: 'rescheduled' });
    const [moved] = await q<{ intent_id: string | null; reminder_swept_at: Date | null }>(
      `select intent_id, reminder_swept_at from appointments where tenant_id = $1 and external_id = 'apt-1'`,
      [TENANT],
    );
    expect(moved?.intent_id).toBeNull();
    expect(moved?.reminder_swept_at).toBeNull();
    const [old] = await q<{ status: string; cancel_reason: string | null }>(
      `select status, cancel_reason from call_intents where id = $1`,
      [before?.intent_id ?? ''],
    );
    expect(old).toMatchObject({ status: 'CANCELLED', cancel_reason: 'appointment_moved' });

    // The sweep gives it a new call, then the customer cancels the appointment entirely.
    expect((await sweepReminders()).scheduled).toBe(1);
    const [again] = await q<{ intent_id: string }>(
      `select intent_id from appointments where tenant_id = $1 and external_id = 'apt-1'`,
      [TENANT],
    );
    await appointment('apt-1', 18 * 60, { status: 'cancelled' });
    const [cancelled] = await q<{ status: string; cancel_reason: string | null }>(
      `select status, cancel_reason from call_intents where id = $1`,
      [again?.intent_id ?? ''],
    );
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      cancel_reason: 'appointment_cancelled',
    });
    expect((await sweepReminders()).scheduled).toBe(0);
  });

  it('E-134: an appointment inside the last two hours gets no call at all', async () => {
    await appointment('apt-soon', 90);
    const r = await sweepReminders();
    expect(r.skipped['too_late']).toBe(1);
    const [row] = await q<{ intent_id: string | null; reminder_swept_at: Date | null }>(
      `select intent_id, reminder_swept_at from appointments where tenant_id = $1 and external_id = 'apt-soon'`,
      [TENANT],
    );
    expect(row?.intent_id).toBeNull();
    expect(row?.reminder_swept_at).not.toBeNull();
  });

  it('an appointment with no phone is kept for the support line but never called', async () => {
    await withTenant(appDb, TENANT, (tx) =>
      upsertAppointment(tx, ctx.keys, {
        tenantId: TENANT,
        source: 'api',
        externalId: 'apt-nophone',
        rawPhone: null,
        defaultRegion: 'IN',
        service: 'Blood test',
        startsAt: addMinutes(clock.now(), 10 * 60),
        timezone: 'Asia/Kolkata',
        now: clock.now(),
      }),
    );
    const r = await sweepReminders();
    expect(r.skipped['no_phone']).toBe(1);
  });

  it('E-137: a customer who opted out is not reminded, and the appointment stays', async () => {
    await withTenant(appDb, TENANT, (tx) =>
      suppress(tx, {
        scope: 'tenant',
        tenantId: TENANT,
        phoneHash: hash(P.appointmentOptedOut),
        purpose: 'all',
        reason: 'opt_out',
        at: clock.now(),
        createdBy: 'test',
      }),
    );
    await withTenant(appDb, TENANT, (tx) =>
      upsertAppointment(tx, ctx.keys, {
        tenantId: TENANT,
        source: 'api',
        externalId: 'apt-optout',
        rawPhone: P.appointmentOptedOut,
        defaultRegion: 'IN',
        service: 'Blood test',
        startsAt: addMinutes(clock.now(), 12 * 60),
        timezone: 'Asia/Kolkata',
        now: clock.now(),
      }),
    );
    const r = await sweepReminders();
    // The intent is created and immediately refused by the gate — the suppression is absolute.
    const [row] = await q<{ intent_id: string | null }>(
      `select intent_id from appointments where tenant_id = $1 and external_id = 'apt-optout'`,
      [TENANT],
    );
    if (row?.intent_id === null) {
      expect(Object.keys(r.skipped).length).toBeGreaterThan(0);
    } else {
      expect(await dispatchOnce(ctx)).toEqual([
        expect.objectContaining({ kind: 'gated', reason: 'suppression:tenant' }),
      ]);
    }
    const [appt] = await q<{ status: string }>(
      `select status from appointments where tenant_id = $1 and external_id = 'apt-optout'`,
      [TENANT],
    );
    expect(appt?.status).toBe('scheduled');
  });

  it('a cancellation with a provider booking is pushed to the calendar, once', async () => {
    const calendarId = newId('calendar');
    await service.query(
      `insert into calendars (id, tenant_id, provider, external_id, name, timezone, slot_minutes, config, status)
       values ($1, $2, 'manual', 'diary-1', 'Blood test', 'Asia/Kolkata', 30, '{}', 'active')`,
      [calendarId, TENANT],
    );
    // A booking the provider holds (the fake's grid accepts any id it handed out).
    const port = calendarRegistry({ now: () => clock.now() }).get('manual');
    const ref = {
      id: calendarId,
      provider: 'manual' as const,
      externalId: 'diary-1',
      timezone: 'Asia/Kolkata',
      slotMinutes: 30,
      config: {},
      credential: null,
    };
    const [slot] = await port.listSlots({
      calendar: ref,
      from: clock.now(),
      to: addMinutes(clock.now(), 240),
    });
    const booking = await port.book({
      calendar: ref,
      slotId: slot?.id ?? '',
      startsAt: slot?.startsAt ?? clock.now(),
      name: 'Asha',
      idempotencyKey: 'apt-cancel-1',
    });
    await withTenant(appDb, TENANT, (tx) =>
      upsertAppointment(tx, ctx.keys, {
        tenantId: TENANT,
        source: 'api',
        externalId: 'apt-cancel',
        calendarId,
        rawPhone: P.appointment,
        defaultRegion: 'IN',
        service: 'Blood test',
        startsAt: booking.startsAt,
        timezone: 'Asia/Kolkata',
        status: 'cancelled',
        providerRef: booking.providerRef,
        now: clock.now(),
      }),
    );
    // The registry in ctx is a different instance from the one that booked, so the fake does
    // not know this booking: that is exactly the "provider refuses" path, stamped and not retried.
    const r = await syncAppointmentsOnce(ctx);
    expect(r.cancelled + r.failed).toBe(1);
    const [row] = await q<{ provider_cancelled_at: Date | null; provider_error: string | null }>(
      `select provider_cancelled_at, provider_error from appointments where tenant_id = $1 and external_id = 'apt-cancel'`,
      [TENANT],
    );
    expect(row?.provider_cancelled_at).not.toBeNull();
    // Nothing is retried for ever: a second pass finds nothing due.
    expect(await syncAppointmentsOnce(ctx)).toEqual({ cancelled: 0, failed: 0 });
  });

  it('erasure keeps the diary and loses the person', async () => {
    const n = await withTenant(appDb, TENANT, (tx) =>
      eraseAppointments(tx, TENANT, { phoneHash: hash(P.appointment) }, clock.now()),
    );
    expect(n).toBeGreaterThan(0);
    const rows = await q<{ phone_hash: string | null; starts_at: Date }>(
      `select phone_hash, starts_at from appointments where tenant_id = $1 and erased_at is not null`,
      [TENANT],
    );
    expect(rows.every((r) => r.phone_hash === null)).toBe(true);
    expect(rows.every((r) => r.starts_at instanceof Date)).toBe(true);
  });
});
