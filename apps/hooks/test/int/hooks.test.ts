import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import { engineWebhookPath, newId } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { EngineRegistry } from '@naaradh/engines-registry';
import { SimulatorAdapter } from '@naaradh/engine-simulator';
import { buildServer } from '../../src/server.js';
import { memoryPublisher } from '../../src/pubsub.js';

const SHOPIFY_SECRET = 'shpss_test_secret';
const SIM_SECRET = 'simulator_webhook_secret_for_tests';
const ENGINE_KEY = 'e'.repeat(32);
const SHOP = 'client-a-test.myshopify.com';
const TENANT = newId('tenant');
const RZP_SECRET = 'rzp_webhook_secret_test';
const RZP_SUB = 'sub_TESTRZP1';

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

  await service.query(
    `insert into billing_subscriptions (id, tenant_id, provider, provider_subscription_id, status, currency, recurring_minor) values ($1, $2, 'razorpay', $3, 'active', 'INR', 199900)`,
    [newId('billingSubscription'), TENANT, RZP_SUB],
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
