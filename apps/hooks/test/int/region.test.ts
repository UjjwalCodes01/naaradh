import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import { EngineRegistry } from '@naaradh/engines-registry';
import { applyDirectorySnapshot, localDirectoryEntries, lookupRegion } from '@naaradh/pipeline';
import { generateRegionKeyPair, newId, signRegionSnapshot } from '@naaradh/shared';
import { FAKE_IN, FAKE_US } from '@naaradh/shared/test/fake-phones';
import { buildServer } from '../../src/server.js';
import { memoryPublisher } from '../../src/pubsub.js';

/**
 * ADR-0012 §4, P6-INF-2 — the region directory and edge routing, on real Postgres:
 * each deployment publishes only its own rows; a peer's signed snapshot is applied, a forged,
 * stale or self-claimed one is refused; a Shopify webhook for a shop another region serves is
 * passed through before anything about it is stored here (E-144).
 */

const SHOPIFY_SECRET = 'shpss_test_secret';
const US_KEYS = generateRegionKeyPair();
const EU_KEYS = generateRegionKeyPair();
const NOW_UNIX = 1_790_000_000;
const TENANT_IN = newId('tenant');
const TENANT_US = newId('tenant'); // waitlisted in India (E-143): never published by India
const LOCAL_SHOP = 'local-in-test.myshopify.com';
const US_SHOP = 'foreign-us-test.myshopify.com';

let pg: TestPostgres;
let service: RoleClient;
let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let publisher: ReturnType<typeof memoryPublisher>;
const forwarded: { url: string; headers: Record<string, string>; body: string }[] = [];
let peerStatus = 200;

const q = async <R extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await service.query<R>(text, params)).rows;

beforeAll(async () => {
  pg = await startTestPostgres();
  service = new RoleClient(pg.urls.service);
  await q(
    `insert into tenants (id, name, country, data_region, status) values
       ($1, 'India merchant', 'IN', 'in', 'active'),
       ($2, 'US merchant', 'US', 'us', 'active')`,
    [TENANT_IN, TENANT_US],
  );
  await q(
    `insert into integrations (id, tenant_id, kind, external_id) values
       ($1, $2, 'shopify', $3), ($4, $5, 'shopify', 'waitlisted-us.myshopify.com')`,
    [newId('integration'), TENANT_IN, LOCAL_SHOP, newId('integration'), TENANT_US],
  );
  await q(
    `insert into numbers (id, tenant_id, e164, region, series, provider, engine, purpose_allowed, status) values
       ($1, null, $2, 'IN', '140', 'exotel', 'simulator', '{transactional}', 'active'),
       ($3, null, $4, 'IN', '140', 'exotel', 'simulator', '{transactional}', 'retired')`,
    [newId('number'), FAKE_IN.merchant, newId('number'), FAKE_IN.transferTarget],
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
        SIMULATOR_WEBHOOK_SECRET: 'x'.repeat(40),
      },
    }),
    shopifySecretFor: () => SHOPIFY_SECRET,
    engineWebhookKey: 'e'.repeat(32),
    region: {
      region: 'in',
      peers: { us: 'https://hooks-us.test', eu: 'https://hooks-eu.test' },
      peerKeys: { us: US_KEYS.publicKey, eu: EU_KEYS.publicKey },
      nowUnix: () => NOW_UNIX,
      fetchImpl: async (input, init) => {
        forwarded.push({
          url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          headers: init?.headers as Record<string, string>,
          body: Buffer.from(init?.body as Buffer).toString('utf8'),
        });
        return new Response('{}', { status: peerStatus });
      },
    },
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

const GENERATED = new Date(NOW_UNIX * 1000).toISOString();
const snapshot = (source: string, entries: { kind: string; key: string }[], at = GENERATED) =>
  JSON.stringify({ source, generated_at: at, entries });
const pushDirectory = (
  body: string,
  sig = signRegionSnapshot(US_KEYS.privateKey, body, NOW_UNIX),
  sender = 'us',
) =>
  app.inject({
    method: 'POST',
    url: '/internal/region-directory',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-naaradh-region': sender,
      'x-naaradh-signature': sig,
    },
  });

describe('this deployment’s own directory', () => {
  it('lists in-region installed shops and non-retired numbers — never a waitlisted foreign tenant', async () => {
    const entries = await localDirectoryEntries(db, 'in');
    expect(entries).toEqual(
      expect.arrayContaining([
        { kind: 'shop', key: LOCAL_SHOP },
        { kind: 'number', key: FAKE_IN.merchant },
      ]),
    );
    expect(entries.map((e) => e.key)).not.toContain('waitlisted-us.myshopify.com');
    expect(entries.map((e) => e.key)).not.toContain(FAKE_IN.transferTarget);
    const applied = await db.transaction((tx) =>
      applyDirectorySnapshot(tx, {
        source: 'in',
        generated_at: new Date().toISOString(),
        entries,
      }),
    );
    expect(applied).toMatchObject({ upserted: entries.length, conflicts: 0 });
    expect(await lookupRegion(db, 'shop', LOCAL_SHOP.toUpperCase())).toBe('in');
  });
});

describe('peer snapshots (POST /internal/region-directory)', () => {
  it('a forged, stale or self-claimed snapshot is refused and nothing changes', async () => {
    const body = snapshot('us', [{ kind: 'shop', key: US_SHOP }]);
    const forger = generateRegionKeyPair();
    expect(
      (await pushDirectory(body, signRegionSnapshot(forger.privateKey, body, NOW_UNIX))).statusCode,
    ).toBe(401);
    expect(
      (await pushDirectory(body, signRegionSnapshot(US_KEYS.privateKey, body, NOW_UNIX - 600)))
        .statusCode,
    ).toBe(401);
    // Our own rows are written only by our own sync job; an unknown sender is not a peer.
    expect((await pushDirectory(body, undefined, 'in')).statusCode).toBe(403);
    expect((await pushDirectory(body, undefined, 'xx')).statusCode).toBe(403);
    // A delayed or replayed old snapshot cannot roll the directory back.
    const old = snapshot('us', [], new Date((NOW_UNIX - 3600) * 1000).toISOString());
    expect((await pushDirectory(old)).statusCode).toBe(409);
    // Keys are validated: a customer's email or a free-form string never lands in the directory.
    expect(
      (await pushDirectory(snapshot('us', [{ kind: 'shop', key: 'a@b.test' }]))).statusCode,
    ).toBe(400);
    expect(await lookupRegion(db, 'shop', US_SHOP)).toBeNull();
  });

  it('a region can speak only for itself: the US, signing with its own key, cannot rewrite EU rows', async () => {
    const eu = snapshot('eu', [{ kind: 'shop', key: 'eu-store-test.myshopify.com' }]);
    expect(
      (await pushDirectory(eu, signRegionSnapshot(EU_KEYS.privateKey, eu, NOW_UNIX), 'eu'))
        .statusCode,
    ).toBe(200);
    // The US signs a snapshot claiming to be the EU's (empty: "release every EU shop").
    const hijack = snapshot('eu', []);
    const asUs = await pushDirectory(
      hijack,
      signRegionSnapshot(US_KEYS.privateKey, hijack, NOW_UNIX),
      'us',
    );
    expect(asUs.statusCode).toBe(403);
    const asEu = await pushDirectory(
      hijack,
      signRegionSnapshot(US_KEYS.privateKey, hijack, NOW_UNIX),
      'eu',
    );
    expect(asEu.statusCode).toBe(401);
    expect(await lookupRegion(db, 'shop', 'eu-store-test.myshopify.com')).toBe('eu');
  });

  it('a peer publishes its shops and numbers; it can never take over ours', async () => {
    const r = await pushDirectory(
      snapshot('us', [
        { kind: 'shop', key: US_SHOP },
        { kind: 'shop', key: LOCAL_SHOP }, // ours — refused as a conflict
        { kind: 'number', key: FAKE_US.transferTarget },
      ]),
    );
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ upserted: 2, removed: 0, conflicts: 1 });
    expect(await lookupRegion(db, 'shop', US_SHOP)).toBe('us');
    expect(await lookupRegion(db, 'shop', LOCAL_SHOP)).toBe('in');
    expect(await lookupRegion(db, 'number', FAKE_US.transferTarget)).toBe('us');
  });

  it('the next full snapshot releases what the peer no longer serves', async () => {
    const r = await pushDirectory(snapshot('us', [{ kind: 'shop', key: US_SHOP }]));
    expect(r.json()).toMatchObject({ removed: 1 });
    expect(await lookupRegion(db, 'number', FAKE_US.transferTarget)).toBeNull();
    expect(await lookupRegion(db, 'shop', US_SHOP)).toBe('us');
  });
});

describe('Shopify webhooks for another region’s shop (E-144)', () => {
  const body = JSON.stringify({ id: 9001, email: 'buyer@example.test', phone: FAKE_US.customer });
  const post = (shop: string, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/shopify/webhooks',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-shopify-topic': 'orders/create',
        'x-shopify-shop-domain': shop,
        'x-shopify-webhook-id': `wh-${shop}-${String(forwarded.length)}`,
        'x-shopify-hmac-sha256': createHmac('sha256', SHOPIFY_SECRET).update(body).digest('base64'),
        ...extra,
      },
    });
  const stored = async (shop: string) =>
    (
      await q<{ n: string }>(
        `select count(*)::text as n from webhook_events where external_account = $1 and payload is not null`,
        [shop],
      )
    )[0]?.n;

  it('is verified, then passed through byte for byte with Shopify’s headers — nothing stored here', async () => {
    const r = await post(US_SHOP);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'forwarded', region: 'us' });
    expect(forwarded.at(-1)).toMatchObject({
      url: 'https://hooks-us.test/shopify/webhooks',
      body,
      headers: {
        'x-shopify-topic': 'orders/create',
        'x-shopify-shop-domain': US_SHOP,
        'x-naaradh-forwarded-from': 'in',
      },
    });
    expect(await stored(US_SHOP)).toBe('0');
    expect(publisher.messages).toHaveLength(0);
  });

  it('a bad HMAC is refused here and never forwarded', async () => {
    const before = forwarded.length;
    expect((await post(US_SHOP, { 'x-shopify-hmac-sha256': 'bm9wZQ==' })).statusCode).toBe(401);
    expect(forwarded.length).toBe(before);
  });

  it('a peer failure asks Shopify to retry; a forwarded request is never forwarded again', async () => {
    peerStatus = 503;
    expect((await post(US_SHOP)).statusCode).toBe(502);
    peerStatus = 200;
    const before = forwarded.length;
    const r = await post(US_SHOP, { 'x-naaradh-forwarded-from': 'us' });
    expect(forwarded.length).toBe(before);
    // Not ours and not re-forwarded: nothing is stored, Shopify is asked to retry (E-144).
    expect(r.statusCode).toBe(503);
    expect(await stored(US_SHOP)).toBe('0');
  });

  it('a shop no region has claimed yet is never stored here: Shopify retries until the directory knows it', async () => {
    const fresh = 'fresh-install-test.myshopify.com';
    const before = forwarded.length;
    const r = await post(fresh);
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('300');
    expect(forwarded.length).toBe(before);
    expect(await stored(fresh)).toBe('0');
  });

  it('our own shops are handled here as always', async () => {
    const before = forwarded.length;
    expect((await post(LOCAL_SHOP)).json()).toMatchObject({ status: 'published' });
    expect(forwarded.length).toBe(before);
  });
});
