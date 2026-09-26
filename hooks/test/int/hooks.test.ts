import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import { engineWebhookPath, newId } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { EngineRegistry } from '@naaradh/engines-registry';
import { SimulatorAdapter } from '@naaradh/engine-simulator';
import { signStripePayload } from '@naaradh/payments';
import { occSharedSecret, occWebhookPath } from '@naaradh/occ';
import { crmSharedSecret, crmWebhookPath } from '@naaradh/crm';
import { buildServer } from '../../src/server.js';
import { memoryPublisher } from '../../src/pubsub.js';

const SHOPIFY_SECRET = 'shpss_test_secret';
const SIM_SECRET = 'simulator_webhook_secret_for_tests';
const ENGINE_KEY = 'e'.repeat(32);
const SHOP = 'client-a-test.myshopify.com';
const TENANT = newId('tenant');
const RZP_SECRET = 'rzp_webhook_secret_test';
const RZP_SUB = 'sub_TESTRZP1';
const STRIPE_SECRET = 'whsec_test_stripe_hooks';
const STRIPE_SESSION = 'cs_test_HOOKS1';
const STRIPE_SUB = 'sub_TESTSTRIPE1';
const NOW_UNIX = 1_790_000_000;
const PROVIDER_KEY = 'o'.repeat(32);
const TENANT_B = newId('tenant');

let pg: TestPostgres;
let service: RoleClient;
let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let publisher: ReturnType<typeof memoryPublisher>;

const shopifyPost = (body: string, overrides: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/shopify/webhooks',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': SHOP,
      'x-shopify-webhook-id': 'wh-1',
      'x-shopify-hmac-sha256': createHmac('sha256', SHOPIFY_SECRET).update(body).digest('base64'),
      ...overrides,
    },
  });

beforeAll(async () => {
  pg = await startTestPostgres();
  service = new RoleClient(pg.urls.service);
  await service.query(
    `insert into tenants (id, name, country, data_region, status) values ($1, 'Client A', 'IN', 'in', 'active')`,
    [TENANT],
  );
  await service.query(
    `insert into integrations (id, tenant_id, kind, external_id) values ($1, $2, 'shopify', $3)`,
    [newId('integration'), TENANT, SHOP],
  );

  // A second merchant on the same provider, for the cross-tenant de-duplication test.
  await service.query(
    `insert into tenants (id, name, country, data_region, status) values ($1, 'Client B', 'IN', 'in', 'active')`,
    [TENANT_B],
  );
  await service.query(
    `insert into integrations (id, tenant_id, kind, external_id) values ($1, $2, 'cashfree', $3)`,
    [newId('integration'), TENANT_B, 'cashfree-account-2'],
  );

  // A CRM lead source (P5-CRM-1); hubspot is deliberately left off.
  await service.query(
    `insert into integrations (id, tenant_id, kind, external_id) values ($1, $2, 'zoho', $3)`,
    [newId('integration'), TENANT, 'zoho-org-1'],
  );

  // Two one-click-checkout providers enabled, one (shiprocket) deliberately not (E-14).
  for (const kind of ['cashfree', 'gokwik'] as const) {
    await service.query(
      `insert into integrations (id, tenant_id, kind, external_id) values ($1, $2, $3, $4)`,
      [newId('integration'), TENANT, kind, `${kind}-account-1`],
    );
  }

  await service.query(
    `insert into billing_subscriptions (id, tenant_id, provider, provider_subscription_id, status, currency, recurring_minor) values ($1, $2, 'razorpay', $3, 'active', 'INR', 199900)`,
    [newId('billingSubscription'), TENANT, RZP_SUB],
  );
  // A dollar checkout still pending: its row is keyed by the Checkout Session (P6-BILL-1).
  await service.query(
    `insert into billing_subscriptions (id, tenant_id, provider, provider_subscription_id, status, currency, recurring_minor) values ($1, $2, 'stripe', $3, 'pending', 'USD', 0)`,
    [newId('billingSubscription'), TENANT, STRIPE_SESSION],
  );
  const conn = createDb({ url: pg.urls.service, max: 2 });
  db = conn.db;
  closeDb = conn.close;
  publisher = memoryPublisher();
  app = await buildServer({
    db,
    publisher,
    registry: new EngineRegistry({
      env: {
        ENGINE_DEFAULT_IN: 'simulator',
        ENGINE_DEFAULT_US: 'simulator',
        SIMULATOR_WEBHOOK_SECRET: SIM_SECRET,
      },
    }),
    shopifySecretFor: () => SHOPIFY_SECRET,
    engineWebhookKey: ENGINE_KEY,
    razorpayWebhookSecret: RZP_SECRET,
    stripeWebhookSecret: STRIPE_SECRET,
    providerWebhookKey: PROVIDER_KEY,
    nowUnix: () => NOW_UNIX,
    rateLimitPerMinute: 10_000,
    logLevel: 'silent',
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app.close();
  await closeDb();
  await service.end();
  await pg.stop();
});

describe('Shopify webhooks (invariant 9, E-52)', () => {
  const body = JSON.stringify({
    id: 5001,
    name: '#1001',
    payment_gateway_names: ['Cash on Delivery (COD)'],
    shipping_address: { phone: FAKE_IN.customer },
  });

  it('verifies the HMAC, dedupes, publishes, and records the tenant', async () => {
    const r = await shopifyPost(body);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'published' });
    expect(publisher.messages).toHaveLength(1);
    expect(publisher.messages[0]).toMatchObject({
      topic: 'shopify.events',
      message: {
        source: 'shopify',
        topic: 'orders/create',
        tenant_id: TENANT,
        external_account: SHOP,
      },
    });
    // The Pub/Sub message carries no PII — the payload stays in Postgres.
    expect(JSON.stringify(publisher.messages[0])).not.toContain(FAKE_IN.customer);
    const row = await service.query<{ status: string; tenant_id: string; payload: { id: number } }>(
      `select status, tenant_id, payload from webhook_events where external_event_id = 'wh-1'`,
    );
    expect(row.rows[0]).toMatchObject({ status: 'published', tenant_id: TENANT });
    expect(row.rows[0]?.payload.id).toBe(5001);
  });

  it('a redelivery of the same webhook id is acknowledged but not published twice', async () => {
    const r = await shopifyPost(body);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'duplicate' });
    expect(publisher.messages).toHaveLength(1);
  });

  it('a bad HMAC is a 401 with no body stored', async () => {
    const r = await shopifyPost(body, {
      'x-shopify-hmac-sha256': 'nope',
      'x-shopify-webhook-id': 'wh-bad',
    });
    expect(r.statusCode).toBe(401);
    const row = await service.query<{ status: string; payload: unknown; signature_valid: boolean }>(
      `select status, payload, signature_valid from webhook_events where external_event_id = 'rejected:wh-bad'`,
    );
    expect(row.rows[0]).toEqual({ status: 'rejected', payload: null, signature_valid: false });
    expect(publisher.messages).toHaveLength(1);
  });

  it('a signature over re-serialised JSON does not verify (raw bytes matter)', async () => {
    const odd = '{"id": 5002 ,  "name":"#1002"}';
    const reserialised = JSON.stringify(JSON.parse(odd));
    const r = await shopifyPost(odd, {
      'x-shopify-webhook-id': 'wh-2',
      'x-shopify-hmac-sha256': createHmac('sha256', SHOPIFY_SECRET)
        .update(reserialised)
        .digest('base64'),
    });
    expect(r.statusCode).toBe(401);
  });

  it('an unknown shop is acknowledged and recorded, not published (Shopify must not retry forever)', async () => {
    const r = await shopifyPost(body, {
      'x-shopify-shop-domain': 'stranger.myshopify.com',
      'x-shopify-webhook-id': 'wh-3',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ignored', reason: 'unknown_shop' });
    expect(publisher.messages).toHaveLength(1);
  });

  it('mandatory compliance topics go through the same verified path', async () => {
    const redact = JSON.stringify({
      shop_id: 1,
      shop_domain: SHOP,
      customer: { id: 9 },
      orders_to_redact: [5001],
    });
    const r = await shopifyPost(redact, {
      'x-shopify-topic': 'customers/redact',
      'x-shopify-webhook-id': 'wh-redact',
      'x-shopify-hmac-sha256': createHmac('sha256', SHOPIFY_SECRET).update(redact).digest('base64'),
    });
    expect(r.statusCode).toBe(200);
    expect(publisher.messages.at(-1)?.message.topic).toBe('customers/redact');
  });

  it('a failed publish is a 500 so Shopify retries, and the retry republishes the same row', async () => {
    const b = JSON.stringify({ id: 5004 });
    const headers = {
      'x-shopify-webhook-id': 'wh-4',
      'x-shopify-hmac-sha256': createHmac('sha256', SHOPIFY_SECRET).update(b).digest('base64'),
    };
    publisher.failNext = 1;
    const first = await shopifyPost(b, headers);
    expect(first.statusCode).toBe(500);
    const failed = await service.query<{ status: string }>(
      `select status from webhook_events where external_event_id = 'wh-4'`,
    );
    expect(failed.rows[0]?.status).toBe('failed');
    const second = await shopifyPost(b, headers);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'republished' });
    const ok = await service.query<{ status: string }>(
      `select status from webhook_events where external_event_id = 'wh-4'`,
    );
    expect(ok.rows[0]?.status).toBe('published');
  });

  it('respects the body limit', async () => {
    const huge = `{"pad":"${'a'.repeat(1_100_000)}"}`;
    const r = await shopifyPost(huge, {
      'x-shopify-webhook-id': 'wh-huge',
      'x-shopify-hmac-sha256': createHmac('sha256', SHOPIFY_SECRET).update(huge).digest('base64'),
    });
    expect(r.statusCode).toBe(413);
  });
});

describe('engine webhooks (invariant 9, E-22, E-23)', () => {
  const path = engineWebhookPath(ENGINE_KEY, 'simulator', TENANT);

  async function simulatorDeliveries(scenario: string) {
    const sim = new SimulatorAdapter({ webhookSecret: SIM_SECRET });
    await sim.placeCall({
      to: FAKE_IN.customer,
      from: FAKE_IN.merchant,
      agentRef: { vendor: 'simulator', agentId: 'a' },
      variables: { __scenario: scenario },
      maxDurationSec: 120,
      metadata: {
        tenant_id: TENANT,
        campaign_id: null,
        call_id: 'att_x',
        purpose: 'transactional',
        script_version: '1',
      },
      webhookUrl: path,
      amd: 'continue',
      locale: 'hi-IN',
      idempotencyKey: `k-${scenario}-${String(Math.random())}`,
    });
    return sim.outbox;
  }

  it('accepts a signed vendor event and publishes it under the tenant from the tag', async () => {
    const [first] = await simulatorDeliveries('answered-human-confirmed');
    if (first === undefined) throw new Error('no delivery');
    const before = publisher.messages.length;
    const r = await app.inject({
      method: 'POST',
      url: path,
      payload: first.rawBody,
      headers: first.headers,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'published' });
    expect(publisher.messages.at(-1)).toMatchObject({
      topic: 'engine.events',
      message: { source: 'engine_simulator', topic: 'call.ringing', tenant_id: TENANT },
    });
    expect(publisher.messages).toHaveLength(before + 1);
  });

  it('dedupes on the vendor event id (E-22)', async () => {
    const [first] = await simulatorDeliveries('webhook-duplicate');
    if (first === undefined) throw new Error('no delivery');
    const a = await app.inject({
      method: 'POST',
      url: path,
      payload: first.rawBody,
      headers: first.headers,
    });
    const b = await app.inject({
      method: 'POST',
      url: path,
      payload: first.rawBody,
      headers: first.headers,
    });
    expect(a.json()).toMatchObject({ status: 'published' });
    expect(b.json()).toMatchObject({ status: 'duplicate' });
  });

  it('rejects a bad vendor signature with 401 and stores no body (E-23)', async () => {
    const deliveries = await simulatorDeliveries('unsigned-webhook');
    const bad = deliveries.at(-1);
    if (bad === undefined) throw new Error('no delivery');
    expect(bad.headers['x-sim-signature']).toBe('deadbeef');
    const r = await app.inject({
      method: 'POST',
      url: path,
      payload: bad.rawBody,
      headers: bad.headers,
    });
    expect(r.statusCode).toBe(401);
    const rows = await service.query<{ n: number }>(
      `select count(*)::int as n from webhook_events where source = 'engine_simulator' and status = 'rejected' and payload is null`,
    );
    expect(rows.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("refuses a valid event posted to another tenant's URL", async () => {
    const [first] = await simulatorDeliveries('answered-human-confirmed');
    if (first === undefined) throw new Error('no delivery');
    const otherPath = engineWebhookPath(ENGINE_KEY, 'simulator', newId('tenant')).replace(
      /\.[0-9a-f]{32}$/,
      '.' + '0'.repeat(32),
    );
    const r = await app.inject({
      method: 'POST',
      url: otherPath,
      payload: first.rawBody,
      headers: first.headers,
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('Razorpay webhooks (P2-BILL-3, invariant 9)', () => {
  const event = (name: string, sub = RZP_SUB, tenant: string | null = TENANT) =>
    JSON.stringify({
      entity: 'event',
      event: name,
      payload: {
        subscription: {
          entity: {
            id: sub,
            plan_id: 'plan_X',
            status: 'halted',
            notes: tenant === null ? [] : { tenant_id: tenant },
          },
        },
        // Payment entities carry the payer's contact details — they must never be stored.
        payment: {
          entity: { id: 'pay_1', email: 'payer@example.test', contact: FAKE_IN.customer },
        },
      },
    });
  const post = (
    body: string,
    sig = createHmac('sha256', RZP_SECRET).update(body).digest('hex'),
    id = `evt_${sig.slice(0, 10)}`,
  ) =>
    app.inject({
      method: 'POST',
      url: '/razorpay/webhooks',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': sig,
        'x-razorpay-event-id': id,
      },
    });

  it('a bad signature is 401 and nothing is published', async () => {
    const before = publisher.messages.length;
    expect((await post(event('subscription.halted'), 'f'.repeat(64))).statusCode).toBe(401);
    expect(publisher.messages.length).toBe(before);
  });

  it('verified → normalised payload stored (no payer PII) → published to billing.events; duplicates are acknowledged once', async () => {
    const body = event('subscription.halted');
    const r = await post(body);
    expect(r.json()).toMatchObject({ status: 'published' });
    const msg = publisher.messages.at(-1);
    expect(msg).toMatchObject({
      topic: 'billing.events',
      message: { source: 'razorpay', tenant_id: TENANT, external_account: RZP_SUB },
    });
    const [row] = (
      await service.query<{ payload: unknown }>(
        `select payload from webhook_events where id = $1`,
        [msg?.message.webhook_event_id],
      )
    ).rows;
    expect(row?.payload).toEqual({
      event: 'subscription.halted',
      subscription_id: RZP_SUB,
      status: 'halted',
    });
    expect(JSON.stringify(row)).not.toContain('payer@example.test');
    expect((await post(body)).json()).toMatchObject({ status: 'duplicate' });
  });

  it('an unknown subscription or a tenant mismatch in the notes is recorded and ignored', async () => {
    expect((await post(event('subscription.activated', 'sub_UNKNOWN1'))).json()).toMatchObject({
      status: 'ignored',
    });
    expect(
      (await post(event('subscription.activated', RZP_SUB, newId('tenant')))).json(),
    ).toMatchObject({ status: 'ignored' });
  });
});

describe('Stripe webhooks (P6-BILL-1, invariant 9)', () => {
  const event = (id: string, type: string, object: Record<string, unknown>) =>
    JSON.stringify({ id, type, data: { object } });
  const post = (
    body: string,
    header = signStripePayload(STRIPE_SECRET, Buffer.from(body), NOW_UNIX),
  ) =>
    app.inject({
      method: 'POST',
      url: '/stripe/webhooks',
      payload: body,
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
    });
  const completed = event('evt_hooks_1', 'checkout.session.completed', {
    id: STRIPE_SESSION,
    object: 'checkout.session',
    subscription: STRIPE_SUB,
    // Checkout carries the payer's details — they must never be stored.
    customer_details: { email: 'payer@example.test', name: 'Test Payer' },
  });

  it('a bad, foreign or replayed signature is 401 and nothing is published', async () => {
    const before = publisher.messages.length;
    const body = Buffer.from(completed);
    for (const header of [
      signStripePayload('whsec_someone_else', body, NOW_UNIX),
      signStripePayload(STRIPE_SECRET, body, NOW_UNIX - 600),
      't=1,v1=' + 'f'.repeat(64),
    ])
      expect((await post(completed, header)).statusCode).toBe(401);
    expect(publisher.messages.length).toBe(before);
  });

  it('a completed checkout finds the pending row by session, stores ids only, publishes once', async () => {
    const r = await post(completed);
    expect(r.json()).toMatchObject({ status: 'published' });
    const msg = publisher.messages.at(-1);
    expect(msg).toMatchObject({
      topic: 'billing.events',
      message: { source: 'stripe', tenant_id: TENANT, external_account: STRIPE_SUB },
    });
    const [row] = (
      await service.query<{ payload: unknown }>(
        `select payload from webhook_events where id = $1`,
        [msg?.message.webhook_event_id],
      )
    ).rows;
    expect(row?.payload).toEqual({
      type: 'checkout.session.completed',
      subscription_id: STRIPE_SUB,
      checkout_session_id: STRIPE_SESSION,
    });
    expect(JSON.stringify(row)).not.toContain('payer@example.test');
    expect((await post(completed)).json()).toMatchObject({ status: 'duplicate' });
  });

  it('events for subscriptions we never created, or for no subscription, are recorded and ignored', async () => {
    const before = publisher.messages.length;
    expect(
      (
        await post(
          event('evt_hooks_2', 'customer.subscription.updated', {
            id: 'sub_NOTOURS1',
            object: 'subscription',
          }),
        )
      ).json(),
    ).toMatchObject({ status: 'ignored' });
    expect(
      (
        await post(event('evt_hooks_3', 'charge.succeeded', { id: 'ch_1', object: 'charge' }))
      ).json(),
    ).toMatchObject({ status: 'ignored' });
    expect(publisher.messages.length).toBe(before);
  });
});

describe('one-click-checkout webhooks (E-14, invariant 9)', () => {
  const cart = {
    type: 'ABANDONED_CHECKOUT',
    event_time: new Date(NOW_UNIX * 1000).toISOString(),
    data: {
      cart_id: 'cf_cart_1',
      total_price: '2499.00',
      currency: 'INR',
      phone: FAKE_IN.customer,
      customer: { first_name: 'Asha', shipping_address: { country_code: 'IN' } },
      line_items: [{ sku_name: 'Blue kurta', quantity: 2 }],
    },
  };
  const body = JSON.stringify(cart);
  const cashfreeSig = (payload: string, ts = String(NOW_UNIX)): string =>
    createHmac('sha256', occSharedSecret(PROVIDER_KEY, 'cashfree', TENANT))
      .update(ts)
      .update(Buffer.from(payload))
      .digest('base64');

  const occPost = (
    provider: 'cashfree' | 'gokwik' | 'shiprocket',
    payload: string,
    headers: Record<string, string> = {},
    path?: string,
  ) =>
    app.inject({
      method: 'POST',
      url: path ?? occWebhookPath(PROVIDER_KEY, provider, TENANT),
      payload,
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('verifies the URL tag and Cashfree’s signature, then publishes to provider.events', async () => {
    const before = publisher.messages.length;
    const r = await occPost('cashfree', body, {
      'x-webhook-signature': cashfreeSig(body),
      'x-webhook-timestamp': String(NOW_UNIX),
      'x-idempotency-key': 'cf-evt-1',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'published' });
    const published = publisher.messages.slice(before);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      topic: 'provider.events',
      message: { source: 'cashfree', topic: 'occ/checkout', tenant_id: TENANT },
    });
    // Invariant 8: the cart's phone number stays in Postgres, never on the bus or in a log.
    expect(JSON.stringify(published[0])).not.toContain(FAKE_IN.customer);
    const row = await service.query<{
      status: string;
      tenant_id: string;
      signature_valid: boolean;
    }>(
      `select status, tenant_id, signature_valid from webhook_events where external_event_id = $1`,
      [`${TENANT}:cf-evt-1`],
    );
    expect(row.rows[0]).toMatchObject({
      status: 'published',
      tenant_id: TENANT,
      signature_valid: true,
    });
  });

  it('a redelivery of the same idempotency key is acknowledged, not published twice', async () => {
    const before = publisher.messages.length;
    const r = await occPost('cashfree', body, {
      'x-webhook-signature': cashfreeSig(body),
      'x-webhook-timestamp': String(NOW_UNIX),
      'x-idempotency-key': 'cf-evt-1',
    });
    expect(r.json()).toMatchObject({ status: 'duplicate' });
    expect(publisher.messages).toHaveLength(before);
  });

  it('404s a URL whose tenant tag does not verify — no oracle, nothing stored', async () => {
    const forged = `/occ/cashfree/${TENANT}.deadbeefdeadbeefdeadbeefdeadbeef`;
    const r = await occPost('cashfree', body, { 'x-webhook-signature': 'x' }, forged);
    expect(r.statusCode).toBe(404);
    const rows = await service.query<{ n: string }>(
      `select count(*)::text as n from webhook_events where topic = 'occ/checkout' and signature_valid = false`,
    );
    expect(rows.rows[0]?.n).toBe('0');
  });

  it('401s a Cashfree delivery with no signature, and records the rejection without a body', async () => {
    const r = await occPost('cashfree', body, { 'x-idempotency-key': 'cf-evt-nosig' });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ reason: 'missing' });
    const row = await service.query<{ payload: unknown; signature_valid: boolean }>(
      `select payload, signature_valid from webhook_events where external_event_id = $1`,
      [`rejected:${TENANT}:cf-evt-nosig`],
    );
    expect(row.rows[0]).toMatchObject({ payload: null, signature_valid: false });
  });

  it('401s a tampered body whose signature no longer matches', async () => {
    const tampered = JSON.stringify({ ...cart, data: { ...cart.data, total_price: '1.00' } });
    const r = await occPost('cashfree', tampered, {
      'x-webhook-signature': cashfreeSig(body),
      'x-webhook-timestamp': String(NOW_UNIX),
      'x-idempotency-key': 'cf-evt-tamper',
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ reason: 'invalid' });
  });

  it('401s a replayed delivery signed outside the window', async () => {
    const stale = String(NOW_UNIX - 3600);
    const r = await occPost('cashfree', body, {
      'x-webhook-signature': cashfreeSig(body, stale),
      'x-webhook-timestamp': stale,
      'x-idempotency-key': 'cf-evt-stale',
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ reason: 'stale' });
  });

  it('accepts an unsigned GoKwik cart on the URL tag alone, its documented state', async () => {
    const before = publisher.messages.length;
    const gokwik = JSON.stringify({
      event: 'cart.abandoned',
      data: { cart_id: 'gk_1', mobile: FAKE_IN.customerAlt, cart_value: '999' },
    });
    const r = await occPost('gokwik', gokwik);
    expect(r.statusCode).toBe(200);
    expect(publisher.messages.slice(before)[0]).toMatchObject({
      message: { source: 'gokwik', tenant_id: TENANT },
    });
  });

  it('401s a GoKwik cart whose signature is present and wrong — no downgrade', async () => {
    const gokwik = JSON.stringify({ data: { cart_id: 'gk_2' } });
    const r = await occPost('gokwik', gokwik, { 'x-gokwik-signature': 'deadbeef' });
    expect(r.statusCode).toBe(401);
  });

  it('ignores a cart for a provider the merchant has not enabled', async () => {
    const before = publisher.messages.length;
    const r = await occPost('shiprocket', JSON.stringify({ cart_token: 'sr_9' }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ignored', reason: 'integration_not_active' });
    expect(publisher.messages).toHaveLength(before);
  });

  it('acknowledges an unreadable cart without publishing, and says which field', async () => {
    const before = publisher.messages.length;
    const r = await occPost('gokwik', JSON.stringify({ data: { no_id_here: true } }), {
      'x-idempotency-key': 'gk-bad-1',
    });
    expect(r.statusCode).toBe(202);
    expect(publisher.messages).toHaveLength(before);
    const row = await service.query<{ status: string; error: string | null }>(
      `select status, error from webhook_events where external_event_id = $1`,
      [`${TENANT}:gk-bad-1`],
    );
    expect(row.rows[0]?.status).toBe('processed');
    expect(row.rows[0]?.error).toContain('cart id');
  });

  it('a stored "optional" cannot switch Cashfree’s signature check off', async () => {
    // The downgrade this closes: the dashboard (or anyone who can write integrations.metadata)
    // setting 'optional' on the one provider that publishes a signing scheme.
    await service.query(
      `update integrations set metadata = '{"occ":{"signature":"optional"}}'::jsonb
        where tenant_id = $1 and kind = 'cashfree'`,
      [TENANT],
    );
    const r = await occPost('cashfree', body, { 'x-idempotency-key': 'cf-evt-downgrade' });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ reason: 'missing' });
    await service.query(`update integrations set metadata = '{}'::jsonb where tenant_id = $1`, [
      TENANT,
    ]);
  });

  it('one merchant cannot burn another merchant’s idempotency key', async () => {
    // webhook_events deduplicates on (source, external_event_id) globally, and the key comes from
    // a header no provider signs. Namespacing it by tenant is what keeps merchant A from
    // swallowing merchant B's genuine cart by claiming the same id first.
    const shared = 'same-id-both-merchants';
    const bodyB = JSON.stringify({
      type: 'ABANDONED_CHECKOUT',
      event_time: new Date(NOW_UNIX * 1000).toISOString(),
      data: { cart_id: 'cf_b_1', total_price: '100.00', phone: FAKE_IN.customerAlt },
    });
    const sigFor = (tenant: string, payload: string): string =>
      createHmac('sha256', occSharedSecret(PROVIDER_KEY, 'cashfree', tenant))
        .update(String(NOW_UNIX))
        .update(Buffer.from(payload))
        .digest('base64');

    const first = await app.inject({
      method: 'POST',
      url: occWebhookPath(PROVIDER_KEY, 'cashfree', TENANT),
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': String(NOW_UNIX),
        'x-webhook-signature': sigFor(TENANT, body),
        'x-idempotency-key': shared,
      },
    });
    expect(first.json()).toMatchObject({ status: 'published' });

    const second = await app.inject({
      method: 'POST',
      url: occWebhookPath(PROVIDER_KEY, 'cashfree', TENANT_B),
      payload: bodyB,
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': String(NOW_UNIX),
        'x-webhook-signature': sigFor(TENANT_B, bodyB),
        'x-idempotency-key': shared,
      },
    });
    // Merchant B's cart is accepted on its own merits, not swallowed as a duplicate.
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'published' });
    const rows = await service.query<{ tenant_id: string }>(
      `select tenant_id from webhook_events where external_event_id in ($1, $2)`,
      [`${TENANT}:${shared}`, `${TENANT_B}:${shared}`],
    );
    expect(rows.rows.map((r) => r.tenant_id).sort()).toEqual([TENANT, TENANT_B].sort());
  });
});

describe('CRM lead webhooks (P5-CRM-1/2)', () => {
  const lead = JSON.stringify({
    id: '4876000000123001',
    First_Name: 'Ananya',
    Phone: FAKE_IN.customer,
    Lead_Source: 'Website form',
  });
  const crmPost = (
    provider: 'zoho' | 'hubspot',
    payload: string,
    headers: Record<string, string> = {},
    path?: string,
  ) =>
    app.inject({
      method: 'POST',
      url: path ?? crmWebhookPath(PROVIDER_KEY, provider, TENANT),
      payload,
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('accepts a lead on the tenant’s URL and publishes it', async () => {
    const before = publisher.messages.length;
    const r = await crmPost('zoho', lead, { 'x-idempotency-key': 'zoho-1' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'published' });
    const published = publisher.messages.slice(before);
    expect(published[0]).toMatchObject({
      topic: 'provider.events',
      message: { source: 'zoho', topic: 'crm/lead', tenant_id: TENANT },
    });
    // Invariant 8: the lead's phone number never leaves Postgres.
    expect(JSON.stringify(published[0])).not.toContain(FAKE_IN.customer);
  });

  it('404s a URL whose tag does not verify', async () => {
    const r = await crmPost(
      'zoho',
      lead,
      {},
      `/crm/zoho/${TENANT}.deadbeefdeadbeefdeadbeefdeadbeef`,
    );
    expect(r.statusCode).toBe(404);
  });

  it('404s an OCC URL reused for the CRM endpoint — one area, one credential', async () => {
    const r = await crmPost(
      'zoho',
      lead,
      {},
      `/crm/zoho/${TENANT}.${occWebhookPath(PROVIDER_KEY, 'gokwik', TENANT).split('.')[1] ?? ''}`,
    );
    expect(r.statusCode).toBe(404);
  });

  it('401s a present-but-wrong signature, even though signing is optional here', async () => {
    const r = await crmPost('zoho', lead, {
      'x-naaradh-signature': 'deadbeef',
      'x-idempotency-key': 'zoho-badsig',
    });
    expect(r.statusCode).toBe(401);
  });

  it('accepts a correctly signed lead', async () => {
    const r = await crmPost('zoho', lead, {
      'x-naaradh-signature': createHmac('sha256', crmSharedSecret(PROVIDER_KEY, 'zoho', TENANT))
        .update(Buffer.from(lead))
        .digest('hex'),
      'x-idempotency-key': 'zoho-signed',
    });
    expect(r.statusCode).toBe(200);
  });

  it('ignores a CRM the merchant has not connected', async () => {
    const r = await crmPost('hubspot', lead, { 'x-idempotency-key': 'hs-1' });
    expect(r.json()).toMatchObject({ status: 'ignored', reason: 'integration_not_active' });
  });

  it('tells the merchant which field is missing when the lead has no phone', async () => {
    const r = await crmPost('zoho', JSON.stringify({ id: '2', Email: 'x@example.com' }), {
      'x-idempotency-key': 'zoho-nophone',
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ reason: 'bad_payload' });
    expect(JSON.stringify(r.json())).toContain('phone');
  });
});
