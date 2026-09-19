import { memoryMailer } from '@naaradh/notify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { createDb, withTenant, type Db } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import {
  meterOutcome,
  openDispute,
  recordStripeCheckout,
  resolveDispute,
  stripePricesFor,
} from '@naaradh/pipeline';
import type {
  RazorpayClient,
  RazorpaySubscription,
  StripeCheckoutSession,
  StripeClient,
  StripeSubscription,
} from '@naaradh/payments';
import { addDays, createLogger, generatePhoneKeyPair, hashPhone, newId } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { EngineRegistry } from '@naaradh/engines-registry';
import { fakeShopify, gqlOrder } from '../../../../packages/shopify-sdk/test/fake-shopify.js';
import { reconcileShopifyOrders } from '../../src/reconcile/shopify-orders.js';
import {
  handleBillingEvent,
  runBillingOnce,
  runReconciliationOnce,
  syncShopifySubscription,
} from '../../src/billing/index.js';
import type { WorkerContext } from '../../src/context.js';
import { inlineSecretResolver } from '../../src/deliveries/secrets.js';
import { memoryRecordingStore } from '../../src/results/recordings.js';
import { recordingWriteback } from '../../src/results/writeback.js';

/**
 * Billing on real Postgres (RLS roles) + Redis, Shopify and Razorpay faked at the HTTP / client
 * boundary (ADR-0008): allowance metering, idempotent usage records, capped → pause → resume
 * (E-61), frozen grace (E-50), Razorpay monthly add-ons net of credits, disputes (E-62), and the
 * nightly reconciliation.
 */

const TS = newId('tenant'); // Shopify-billed
const TR = newId('tenant'); // Razorpay-billed
const TU = newId('tenant'); // Stripe-billed (USD, P6-BILL-1)
const SHOP = 'client-s.myshopify.com';
const HASH_KEY = 'h'.repeat(32);
const keyPair = generatePhoneKeyPair();
let current = new Date('2026-09-14T06:30:00Z');
const clock = { now: () => new Date(current.getTime()) };

let pg: TestPostgres;
let redisContainer: StartedRedisContainer;
let redis: Redis;
let service: RoleClient;
let app: Db;
let ctx: WorkerContext;
let closers: (() => Promise<void>)[] = [];
const shopify = fakeShopify({ token: 'shpat_test' });
let subGid = '';

/** In-memory Razorpay with the same contract as the real client. */
function fakeRazorpay() {
  const subs = new Map<string, RazorpaySubscription>();
  const addons: { sub: string; amount: number; description: string | undefined }[] = [];
  const client: RazorpayClient = {
    async createSubscription(input) {
      const s: RazorpaySubscription = {
        id: `sub_${String(subs.size + 1)}R`,
        planId: input.planId,
        status: 'created',
        shortUrl: 'https://rzp.io/i/test',
        currentEnd: null,
        notes: input.notes,
      };
      subs.set(s.id, s);
      return s;
    },
    async fetchSubscription(id) {
      const s = subs.get(id);
      if (s === undefined) throw new Error('not found');
      return s;
    },
    async createAddon(subscriptionId, input) {
      addons.push({
        sub: subscriptionId,
        amount: input.amountMinor,
        description: input.description,
      });
      return { id: `ao_${String(addons.length)}` };
    },
    async cancelSubscription(id) {
      const s = subs.get(id);
      if (s === undefined) throw new Error('not found');
      const c = { ...s, status: 'cancelled' as const };
      subs.set(id, c);
      return c;
    },
  };
  return { client, subs, addons };
}
const razorpay = fakeRazorpay();

/** In-memory Stripe with the same contract as the real client. */
function fakeStripe() {
  const sessions = new Map<string, StripeCheckoutSession>();
  const subs = new Map<string, StripeSubscription>();
  const items: { customer: string; sub: string; amount: number; currency: string; key: string }[] =
    [];
  const client: StripeClient = {
    async createCheckoutSession(input) {
      const s: StripeCheckoutSession = {
        id: `cs_test_${String(sessions.size + 1)}`,
        url: 'https://checkout.stripe.test/c',
        status: 'open',
        subscriptionId: null,
        customerId: null,
        tenantId: input.tenantId,
      };
      sessions.set(s.id, s);
      return s;
    },
    async retrieveCheckoutSession(id) {
      const s = sessions.get(id);
      if (s === undefined) throw new Error('not found');
      return s;
    },
    async retrieveSubscription(id) {
      const s = subs.get(id);
      if (s === undefined) throw new Error('not found');
      return s;
    },
    async createInvoiceItem(input) {
      items.push({
        customer: input.customerId,
        sub: input.subscriptionId,
        amount: input.amountMinor,
        currency: input.currency,
        key: input.idempotencyKey,
      });
      return { id: `ii_${String(items.length)}` };
    },
    async cancelSubscription(id) {
      const s = subs.get(id);
      if (s === undefined) throw new Error('not found');
      const c = { ...s, status: 'canceled' as const };
      subs.set(id, c);
      return c;
    },
  };
  /** The merchant pays: Stripe completes the session and creates the subscription. */
  const pay = (sessionId: string, tenantId: string) => {
    const s = sessions.get(sessionId);
    if (s === undefined) throw new Error('not found');
    const subId = `sub_U${String(subs.size + 1)}`;
    sessions.set(sessionId, {
      ...s,
      status: 'complete',
      subscriptionId: subId,
      customerId: 'cus_U1',
    });
    subs.set(subId, {
      id: subId,
      status: 'active',
      customerId: 'cus_U1',
      currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
      currency: 'USD',
      tenantId,
    });
    return subId;
  };
  return { client, sessions, subs, items, pay };
}
const stripe = fakeStripe();

const q = async <R extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await service.query<R>(text, params)).rows;
const tenantBilling = async (id: string) =>
  (
    await q<{ billing_status: string; billing_grace_until: Date | null; plan_code: string | null }>(
      `select billing_status, billing_grace_until, plan_code from tenants where id = $1`,
      [id],
    )
  )[0];
const meter = (
  tenant: string,
  at = clock.now(),
  vendorCostMinor: number | null = null,
  outcomeId = newId('outcome'),
) =>
  withTenant(app, tenant, (tx) =>
    meterOutcome(tx, {
      tenantId: tenant,
      outcomeId,
      at,
      vendorCostMinor,
      vendorCostCurrency: vendorCostMinor === null ? null : 'INR',
    }),
  );

beforeAll(async () => {
  pg = await startTestPostgres();
  redisContainer = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(redisContainer.getConnectionUrl());
  service = new RoleClient(pg.urls.service);
  await q(
    `insert into tenants (id, name, country, data_region, status, billing_status, billing_provider, plan_code, billing_overrides)
     values ($1, 'Shopify merchant', 'IN', 'in', 'active', 'active', 'shopify', 'growth', '{"outcome_included": 1}'),
            ($2, 'Razorpay merchant', 'IN', 'in', 'active', 'active', 'razorpay', 'starter', '{"outcome_included": 0}')`,
    [TS, TR],
  );
  await q(
    `insert into tenants (id, name, country, data_region, status, currency, billing_overrides)
     values ($1, 'Dollar merchant', 'US', 'us', 'active', 'USD', '{"outcome_included": 0}')`,
    [TU],
  );
  await q(
    `insert into integrations (id, tenant_id, kind, external_id, credentials_secret_ref) values ($1, $2, 'shopify', $3, 'inline:shpat_test')`,
    [newId('integration'), TS, SHOP],
  );

  // An ACTIVE Shopify subscription (as if the merchant approved it in the embedded app).
  subGid = 'gid://shopify/AppSubscription/1001';
  shopify.subscriptions.set(subGid, {
    id: subGid,
    status: 'ACTIVE',
    test: true,
    currentPeriodEnd: '2026-10-10T00:00:00Z',
    recurring: { amount: '4999.00', currencyCode: 'INR' },
    capped: { amount: '10.00', currencyCode: 'INR' },
    balanceUsed: 0,
    usageRecords: new Map(),
  });
  await q(
    `insert into billing_subscriptions (id, tenant_id, provider, provider_subscription_id, provider_line_item_id, plan_code, status, currency, recurring_minor, capped_amount_minor, activated_at)
     values ($1, $2, 'shopify', $3, $4, 'growth', 'active', 'INR', 499900, 1000, now())`,
    [newId('billingSubscription'), TS, subGid, `${subGid}/usage`],
  );
  const rz = await razorpay.client.createSubscription({
    planId: 'plan_S',
    notes: { tenant_id: TR },
  });
  razorpay.subs.set(rz.id, { ...rz, status: 'active' });
  await q(
    `insert into billing_subscriptions (id, tenant_id, provider, provider_subscription_id, plan_code, status, currency, recurring_minor, activated_at)
     values ($1, $2, 'razorpay', $3, 'starter', 'active', 'INR', 199900, now())`,
    [newId('billingSubscription'), TR, rz.id],
  );

  const a = createDb({ url: pg.urls.app, max: 3 });
  const s = createDb({ url: pg.urls.service, max: 3 });
  app = a.db;
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
    log: createLogger({ service: 'billing-int', level: 'silent' }),
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
    shopifyAdmin: { apiVersion: '2026-07', fetchImpl: shopify.fetch },
    razorpay: razorpay.client,
    stripe: stripe.client,
    mailer: memoryMailer(),
    dashboardUrl: 'https://app.naaradh.test',
    workerId: 'billing-int',
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

describe('metering (SPEC §2.2)', () => {
  it('billing.included_allowance_first — the plan’s included outcomes are ₹0, the next is the plan price, replays never double-meter', async () => {
    const first = await meter(TS);
    const secondId = newId('outcome');
    const second = await meter(TS, clock.now(), null, secondId);
    expect(first).toMatchObject({ included: true, unitMinor: 0 });
    expect(second).toMatchObject({ included: false, unitMinor: 800 }); // growth: ₹8
    // call.ended redelivered for the same outcome: same row, nothing new.
    expect(await meter(TS, clock.now(), null, secondId)).toMatchObject({
      ledgerId: second.ledgerId,
      duplicate: true,
    });
    expect(await q(`select 1 from billing_ledger where tenant_id = $1`, [TS])).toHaveLength(2);
  });
});

describe('Shopify usage records (P2-SHOP-3)', () => {
  it('billing.usage_record_idempotent — each chargeable ledger row is posted once, keyed by the ledger id', async () => {
    const r = await runBillingOnce(ctx);
    expect(r.created.shopify).toBe(1); // the ₹8 row; the ₹0 included row is not a charge
    expect(r.posted).toBe(1);
    const sub = shopify.subscriptions.get(subGid);
    expect(sub?.balanceUsed).toBe(800);
    const [posting] = await q<{
      status: string;
      idempotency_key: string;
      provider_ref: string;
      amount_minor: string;
    }>(
      `select status, idempotency_key, provider_ref, amount_minor from billing_postings where tenant_id = $1`,
      [TS],
    );
    expect(posting).toMatchObject({ status: 'posted', amount_minor: '800' });
    expect(sub?.usageRecords.has(posting?.idempotency_key ?? '')).toBe(true);
    expect(await runBillingOnce(ctx)).toMatchObject({ created: { shopify: 0 }, posted: 0 });
  });

  it('billing.capped_pause — usage over the cap parks the charge and caps the tenant (gate refuses); a raised cap resumes and re-posts (E-61)', async () => {
    await meter(TS); // ₹8 more → 1600 > cap 1000
    const r = await runBillingOnce(ctx);
    expect(r).toMatchObject({ capped: 1, posted: 0 });
    expect((await tenantBilling(TS))?.billing_status).toBe('capped');
    expect(
      await q(`select 1 from billing_postings where tenant_id = $1 and status = 'capped'`, [TS]),
    ).toHaveLength(1);

    const sub = shopify.subscriptions.get(subGid);
    if (sub !== undefined) sub.capped = { amount: '5000.00', currencyCode: 'INR' }; // merchant approved a higher cap
    expect(await syncShopifySubscription(ctx, TS, subGid)).toBe('shopify:ACTIVE:active');
    expect((await tenantBilling(TS))?.billing_status).toBe('active');
    expect(await runBillingOnce(ctx)).toMatchObject({ posted: 1 });
    expect(shopify.subscriptions.get(subGid)?.balanceUsed).toBe(1600);
  });

  it('billing.frozen_grace — FROZEN gives 3 days of grace; a replacement plan being ACTIVE beats the old one CANCELLED (E-50)', async () => {
    const sub = shopify.subscriptions.get(subGid);
    if (sub !== undefined) sub.status = 'FROZEN';
    await syncShopifySubscription(ctx, TS, subGid);
    const frozen = await tenantBilling(TS);
    expect(frozen?.billing_status).toBe('frozen');
    expect(frozen?.billing_grace_until?.toISOString()).toBe(addDays(clock.now(), 3).toISOString());
    // A second webhook does not extend the grace.
    current = addDays(current, 1);
    await syncShopifySubscription(ctx, TS, subGid);
    expect((await tenantBilling(TS))?.billing_grace_until?.toISOString()).toBe(
      frozen?.billing_grace_until?.toISOString(),
    );

    // The merchant picks a new plan (Scale); Shopify activates it and cancels the old one.
    const newGid = 'gid://shopify/AppSubscription/1002';
    shopify.subscriptions.set(newGid, {
      ...(sub as NonNullable<typeof sub>),
      id: newGid,
      status: 'ACTIVE',
      usageRecords: new Map(),
      balanceUsed: 0,
    });
    await q(
      `insert into billing_subscriptions (id, tenant_id, provider, provider_subscription_id, plan_code, status, currency, recurring_minor) values ($1, $2, 'shopify', $3, 'scale', 'pending', 'INR', 1299900)`,
      [newId('billingSubscription'), TS, newGid],
    );
    expect(await syncShopifySubscription(ctx, TS, newGid)).toBe('shopify:ACTIVE:active');
    if (sub !== undefined) sub.status = 'CANCELLED';
    expect(await syncShopifySubscription(ctx, TS, subGid)).toBe('shopify:CANCELLED:active');
    const t = await tenantBilling(TS);
    expect(t).toMatchObject({
      billing_status: 'active',
      billing_grace_until: null,
      plan_code: 'scale',
    });
  });

  it('a subscription for a different shop/tenant is never adopted', async () => {
    expect(await syncShopifySubscription(ctx, TR, subGid)).toBe('no_store');
  });
});

describe('Razorpay add-ons (P2-BILL-3)', () => {
  it('billing.razorpay_period_addon — one add-on per closed period, net of credits; the open period waits', async () => {
    const august = new Date('2026-08-20T06:30:00Z');
    await meter(TR, august);
    await meter(TR, august); // starter: ₹10 each, nothing included (override)
    await q(
      `insert into billing_ledger (id, tenant_id, kind, ref, qty, unit_minor, total_minor, currency, period, provider) values ($1, $2, 'credit', $3, 1, -1000, -1000, 'INR', '2026-08', 'razorpay')`,
      [newId('ledger'), TR, newId('dispute')],
    );
    await meter(TR); // September — still open
    const r = await runBillingOnce(ctx);
    expect(r.created.razorpay).toBe(1);
    expect(razorpay.addons).toEqual([
      {
        sub: expect.stringMatching(/^sub_/),
        amount: 1000,
        description: expect.stringContaining('2026-08'),
      },
    ]);
    const [p] = await q<{ status: string; provider_ref: string; period: string }>(
      `select status, provider_ref, period from billing_postings where tenant_id = $1`,
      [TR],
    );
    expect(p).toEqual({ status: 'posted', provider_ref: 'ao_1', period: '2026-08' });
    expect((await runBillingOnce(ctx)).created.razorpay).toBe(0);
  });

  it('a verified Razorpay webhook is only a hint: the fetched status decides (halted → frozen with grace)', async () => {
    const [sub] = await q<{ provider_subscription_id: string }>(
      `select provider_subscription_id from billing_subscriptions where tenant_id = $1`,
      [TR],
    );
    const id = sub?.provider_subscription_id ?? '';
    const existing = razorpay.subs.get(id);
    if (existing !== undefined) razorpay.subs.set(id, { ...existing, status: 'halted' });
    const eventId = newId('webhookEvent');
    await q(
      `insert into webhook_events (id, source, external_event_id, topic, tenant_id, external_account, status, signature_valid, payload, payload_sha256)
       values ($1, 'razorpay', $2, 'subscription.charged', $3, $4, 'published', true, $5, 'x')`,
      // The body claims "charged" — the fetch says "halted", and the fetch wins.
      [
        eventId,
        `evt_${eventId}`,
        TR,
        id,
        JSON.stringify({ event: 'subscription.charged', subscription_id: id, status: 'active' }),
      ],
    );
    await handleBillingEvent(ctx, {
      webhook_event_id: eventId,
      source: 'razorpay',
      topic: 'subscription.charged',
      tenant_id: TR,
      external_account: id,
      received_at: clock.now().toISOString(),
    });
    expect((await tenantBilling(TR))?.billing_status).toBe('frozen');
    const [ev] = await q<{ status: string; error: string | null }>(
      `select status, error from webhook_events where id = $1`,
      [eventId],
    );
    expect(ev).toEqual({ status: 'processed', error: 'razorpay:halted:frozen' });
  });
});

describe('Stripe (P6-BILL-1)', () => {
  const stripeEvent = async (
    topic: string,
    payload: { subscription_id: string | null; checkout_session_id: string | null },
  ) => {
    const eventId = newId('webhookEvent');
    await q(
      `insert into webhook_events (id, source, external_event_id, topic, tenant_id, external_account, status, signature_valid, payload, payload_sha256)
       values ($1, 'stripe', $2, $3, $4, $5, 'published', true, $6, 'x')`,
      [
        eventId,
        `evt_${eventId}`,
        topic,
        TU,
        payload.subscription_id ?? payload.checkout_session_id,
        JSON.stringify({ type: topic, ...payload }),
      ],
    );
    await handleBillingEvent(ctx, {
      webhook_event_id: eventId,
      source: 'stripe',
      topic,
      tenant_id: TU,
      external_account: payload.subscription_id ?? payload.checkout_session_id ?? '',
      received_at: clock.now().toISOString(),
    });
    return (
      await q<{ status: string; error: string | null }>(
        `select status, error from webhook_events where id = $1`,
        [eventId],
      )
    )[0];
  };
  const actor = { tenantId: TU, type: 'user' as const, id: 'usr_test' };
  const input = { plan_code: 'starter', inbound_plan_code: null };

  it('a rupee account is refused; a dollar account gets a pending row keyed by the session', async () => {
    await expect(
      withTenant(app, TR, (tx) => stripePricesFor(tx, TR, { starter: 'price_S' }, input, 'INR')),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const prices = await withTenant(app, TU, (tx) =>
      stripePricesFor(tx, TU, { starter: 'price_S' }, input, 'USD'),
    );
    expect(prices).toEqual(['price_S']);
    const session = await stripe.client.createCheckoutSession({
      priceIds: prices,
      tenantId: TU,
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/no',
      idempotencyKey: 'k',
    });
    await withTenant(app, TU, (tx) => recordStripeCheckout(tx, actor, input, session, 'USD'));
    const [row] = await q<{ status: string; provider_subscription_id: string; currency: string }>(
      `select status, provider_subscription_id, currency from billing_subscriptions where tenant_id = $1`,
      [TU],
    );
    expect(row).toEqual({
      status: 'pending',
      provider_subscription_id: session.id,
      currency: 'USD',
    });
  });

  it('an open session changes nothing; once paid, the fetched subscription activates the tenant', async () => {
    const [row] = await q<{ provider_subscription_id: string }>(
      `select provider_subscription_id from billing_subscriptions where tenant_id = $1`,
      [TU],
    );
    const sessionId = row?.provider_subscription_id ?? '';
    expect(
      await stripeEvent('checkout.session.completed', {
        subscription_id: null,
        checkout_session_id: sessionId,
      }),
    ).toEqual({ status: 'processed', error: 'stripe:checkout_open' });
    expect((await tenantBilling(TU))?.billing_status).not.toBe('active');

    const subId = stripe.pay(sessionId, TU);
    expect(
      await stripeEvent('checkout.session.completed', {
        subscription_id: subId,
        checkout_session_id: sessionId,
      }),
    ).toMatchObject({ status: 'processed', error: expect.stringMatching(/^stripe:active:/) });
    expect((await tenantBilling(TU))?.billing_status).toBe('active');
    const [sub] = await q<{ provider_subscription_id: string; provider_customer_id: string }>(
      `select provider_subscription_id, provider_customer_id from billing_subscriptions where tenant_id = $1`,
      [TU],
    );
    expect(sub).toEqual({ provider_subscription_id: subId, provider_customer_id: 'cus_U1' });
  });

  it('an active subscriber cannot open a second checkout (no double plan fee)', async () => {
    await expect(
      withTenant(app, TU, (tx) => stripePricesFor(tx, TU, { starter: 'price_S' }, input, 'USD')),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('usage for a closed period is one invoice item in cents, never re-posted', async () => {
    const august = new Date('2026-08-20T06:30:00Z');
    await meter(TU, august);
    await meter(TU, august);
    const r = await runBillingOnce(ctx);
    expect(r.created.stripe).toBe(1);
    expect(stripe.items).toEqual([
      {
        customer: 'cus_U1',
        sub: expect.stringMatching(/^sub_U/),
        amount: expect.any(Number),
        currency: 'USD',
        key: `stripe:${TU}:2026-08`,
      },
    ]);
    expect(stripe.items[0]?.amount).toBeGreaterThan(0);
    expect((await runBillingOnce(ctx)).created.stripe).toBe(0);
    expect(stripe.items).toHaveLength(1);
  });

  it('the webhook is a hint: past_due fetched from Stripe freezes the tenant with grace (E-50)', async () => {
    const [sub] = await q<{ provider_subscription_id: string }>(
      `select provider_subscription_id from billing_subscriptions where tenant_id = $1`,
      [TU],
    );
    const id = sub?.provider_subscription_id ?? '';
    const existing = stripe.subs.get(id);
    if (existing !== undefined) stripe.subs.set(id, { ...existing, status: 'past_due' });
    expect(
      await stripeEvent('invoice.paid', { subscription_id: id, checkout_session_id: null }),
    ).toEqual({ status: 'processed', error: 'stripe:past_due:frozen' });
    const t = await tenantBilling(TU);
    expect(t?.billing_status).toBe('frozen');
    expect(t?.billing_grace_until).not.toBeNull();
  });
});

describe('disputes (E-62)', () => {
  async function billedOutcome(tenant: string, charged: boolean, billedAt: Date) {
    const contactId = newId('contact');
    await q(
      `insert into contacts (id, tenant_id, phone_hash, phone_masked, region) values ($1, $2, $3, 'x', 'IN') on conflict do nothing`,
      [contactId, tenant, hashPhone(FAKE_IN.customer, HASH_KEY)],
    );
    const [c] = await q<{ id: string }>(
      `select id from contacts where tenant_id = $1 and phone_hash = $2`,
      [tenant, hashPhone(FAKE_IN.customer, HASH_KEY)],
    );
    const uc = newId('useCase');
    await q(
      `insert into use_cases (id, tenant_id, kind, purpose, enabled) values ($1, $2, 'cod_confirm', 'transactional', true) on conflict do nothing`,
      [uc, tenant],
    );
    const [u] = await q<{ id: string }>(
      `select id from use_cases where tenant_id = $1 and kind = 'cod_confirm'`,
      [tenant],
    );
    const intentId = newId('intent');
    await q(
      `insert into call_intents (id, tenant_id, use_case_id, use_case, purpose, contact_id, phone_hash, recipient_region, source, external_ref, external_refs, event_ts, not_before, not_after, status, locale, idempotency_key)
       values ($1, $2, $3, 'cod_confirm', 'transactional', $4, $5, 'IN', 'shopify', $1, array[$1::text], now(), now(), now() + interval '30 minutes', 'COMPLETED', 'hi-IN', $1)`,
      [intentId, tenant, u?.id, c?.id, hashPhone(FAKE_IN.customer, HASH_KEY)],
    );
    const attemptId = newId('attempt');
    await q(
      `insert into call_attempts (id, tenant_id, intent_id, contact_id, phone_hash, direction, purpose, attempt_no, engine, from_e164, amd_mode, max_duration_sec, idempotency_key, status)
       values ($1, $2, $3, $4, $5, 'outbound', 'transactional', 1, 'simulator', $6, 'continue', 120, $1, 'ENDED')`,
      [attemptId, tenant, intentId, c?.id, hashPhone(FAKE_IN.customer, HASH_KEY), FAKE_IN.merchant],
    );
    const outcomeId = newId('outcome');
    const ledgerId = newId('ledger');
    const price = charged ? 800 : 0;
    await q(
      `insert into billing_ledger (id, tenant_id, kind, ref, qty, unit_minor, total_minor, currency, period, provider) values ($1, $2, 'outcome', $3, 1, $4, $4, 'INR', '2026-09', 'shopify')`,
      [ledgerId, tenant, outcomeId, price],
    );
    await q(
      `insert into call_outcomes (id, tenant_id, attempt_id, intent_id, outcome, confidence, extraction_method, billable, billable_reason, billed_at, billing_ledger_id)
       values ($1, $2, $3, $4, 'confirmed', 0.95, 'engine', true, 'ok', $5, $6)`,
      [outcomeId, tenant, attemptId, intentId, billedAt, ledgerId],
    );
    return outcomeId;
  }

  it('billing.dispute_credit_path — within 7 days of a charge: open → accept → a negative credit row; the ledger is never edited', async () => {
    const outcomeId = await billedOutcome(TS, true, addDays(clock.now(), -2));
    const disputeId = await withTenant(app, TS, (tx) =>
      openDispute(tx, {
        tenantId: TS,
        outcomeId,
        reason: 'customer never confirmed, recording shows a wrong number',
        openedBy: 'api_key:test',
        actorType: 'api_key',
        at: clock.now(),
      }),
    );
    await expect(
      withTenant(app, TS, (tx) =>
        openDispute(tx, {
          tenantId: TS,
          outcomeId,
          reason: 'second dispute, same outcome',
          openedBy: 'x',
          actorType: 'api_key',
          at: clock.now(),
        }),
      ),
    ).rejects.toThrow(/already has a dispute/);
    const { creditLedgerId } = await ctx.service.transaction((tx) =>
      resolveDispute(tx, {
        disputeId,
        decision: 'accepted',
        by: 'staff@naaradh.test',
        resolution: 'recording confirms a wrong number; credit issued',
        at: clock.now(),
      }),
    );
    const [credit] = await q<{ kind: string; total_minor: string; ref: string }>(
      `select kind, total_minor, ref from billing_ledger where id = $1`,
      [creditLedgerId],
    );
    expect(credit).toEqual({ kind: 'credit', total_minor: '-800', ref: disputeId });
    await expect(
      ctx.service.transaction((tx) =>
        resolveDispute(tx, {
          disputeId,
          decision: 'rejected',
          by: 'x',
          resolution: 'changing my mind now',
          at: clock.now(),
        }),
      ),
    ).rejects.toThrow(/already accepted/);
  });

  it('nothing to dispute when the outcome was within the allowance, or after 7 days', async () => {
    const included = await billedOutcome(TS, false, clock.now());
    await expect(
      withTenant(app, TS, (tx) =>
        openDispute(tx, {
          tenantId: TS,
          outcomeId: included,
          reason: 'this one was free anyway',
          openedBy: 'x',
          actorType: 'api_key',
          at: clock.now(),
        }),
      ),
    ).rejects.toThrow(/allowance/);
    const old = await billedOutcome(TS, true, addDays(clock.now(), -8));
    await expect(
      withTenant(app, TS, (tx) =>
        openDispute(tx, {
          tenantId: TS,
          outcomeId: old,
          reason: 'too late to ask about this',
          openedBy: 'x',
          actorType: 'api_key',
          at: clock.now(),
        }),
      ),
    ).rejects.toThrow(/within 7 days/);
  });
});

describe('nightly reconciliation (P2-BILL-1, E-33)', () => {
  it('posted totals match Shopify’s balance; a call that cost more than it earned is flagged', async () => {
    await meter(TS, clock.now(), 900_000); // ₹9,000 of vendor cost on an ₹8 outcome
    const r = await runReconciliationOnce(ctx);
    expect(r.shopifyChecked).toBeGreaterThanOrEqual(1);
    expect(r.mismatches).toBe(0);
    expect(r.lowMargin).toBeGreaterThanOrEqual(1);
  });
});

describe('hourly Shopify order reconcile (E-53, P2-SHOP-5)', () => {
  it('creates the intent a missed webhook would have, gates a late one, and never duplicates', async () => {
    await q(
      `insert into use_cases (id, tenant_id, kind, purpose, enabled, config) values ($1, $2, 'cod_confirm', 'transactional', true, '{"pilotPercent":100}') on conflict do nothing`,
      [newId('useCase'), TS],
    );
    // Inside the calling window (IST daytime) so the timely order is schedulable.
    current = new Date('2026-09-20T06:30:00Z');
    const fresh = new Date(current.getTime() - 5 * 60_000).toISOString();
    const late = new Date(current.getTime() - 50 * 60_000).toISOString();
    shopify.listedOrders.push(
      gqlOrder('2001', { createdAt: fresh, updatedAt: fresh }),
      gqlOrder('2002', {
        createdAt: late,
        updatedAt: late,
        shippingAddress: {
          phone: FAKE_IN.customerAlt,
          zip: '110001',
          provinceCode: 'DL',
          countryCodeV2: 'IN',
          city: 'Delhi',
        },
      }),
      gqlOrder('2003', {
        createdAt: fresh,
        updatedAt: fresh,
        paymentGatewayNames: ['shopify_payments'],
      }),
    );
    const r = await reconcileShopifyOrders(ctx, { force: true });
    expect(r).toMatchObject({ stores: 1, ordersSeen: 3, failures: 0 });
    const intents = await q<{ external_ref: string; status: string; not_after: Date }>(
      `select external_ref, status, not_after from call_intents where tenant_id = $1 and external_ref in ('2001','2002','2003') order by external_ref`,
      [TS],
    );
    expect(intents.map((i) => i.external_ref)).toEqual(['2001', '2002']); // prepaid 2003: no call
    expect(intents[0]?.status).toBe('SCHEDULED');
    // The late one is recorded with its ORIGINAL envelope (invariant 4): already closed, so the
    // gate refuses it at dispatch with window:transactional_expired — it is never called late.
    expect(intents[1]?.not_after.getTime()).toBeLessThan(current.getTime());
    // The order cache has all three, so the support agent can answer about any of them.
    const cached = await q(
      `select 1 from orders where tenant_id = $1 and external_id in ('2001','2002','2003')`,
      [TS],
    );
    expect(cached.length).toBe(3);
    // A second pass (or the webhook arriving late) changes nothing.
    const again = await reconcileShopifyOrders(ctx, { force: true });
    expect(again?.intentsCreated).toBe(0);
    const count = await q<{ n: number }>(
      `select count(*)::int as n from call_intents where tenant_id = $1 and external_ref in ('2001','2002')`,
      [TS],
    );
    expect(count[0]?.n).toBe(2);
    // Without force, one pass per hour across instances.
    expect(await reconcileShopifyOrders(ctx)).not.toBeNull();
    expect(await reconcileShopifyOrders(ctx)).toBeNull();
    shopify.listedOrders.length = 0;
  });
});
