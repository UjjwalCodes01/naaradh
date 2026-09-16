import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { createDb, type Db } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import {
  decryptPhone,
  generateApiKey,
  generatePhoneKeyPair,
  hashPhone,
  newId,
} from '@naaradh/shared';
import { DEFAULT_CLOSED_MESSAGES, DEFAULT_INBOUND_GREETINGS } from '@naaradh/scripts';
import { FAKE_IN, INVALID_PHONES } from '@naaradh/shared/test/fake-phones';
import { devSigner } from '../../src/routes/calls.js';
import { inlineSecretStore } from '../../src/secrets.js';
import { buildServer } from '../../src/server.js';

const TENANT = newId('tenant');
const HASH_KEY = 'h'.repeat(32);
const keyPair = generatePhoneKeyPair();
const staffPair = generatePhoneKeyPair();
const NOW = new Date('2026-09-14T06:30:00Z');

let pg: TestPostgres;
let redisContainer: StartedRedisContainer;
let redis: Redis;
let service: RoleClient;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildServer>>;

const secretKey = generateApiKey('live');
const publicKey = generateApiKey('pk');
const revokedKey = generateApiKey('live');
const narrowKey = generateApiKey('live'); // intents:create only, daily cap 1

const auth = (key: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${key}`,
  'content-type': 'application/json',
  ...extra,
});

beforeAll(async () => {
  pg = await startTestPostgres();
  redisContainer = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(redisContainer.getConnectionUrl());
  service = new RoleClient(pg.urls.service);

  await service.query(
    `insert into tenants (id, name, country, data_region, status, billing_status) values ($1, 'Client B', 'IN', 'in', 'active', 'active')`,
    [TENANT],
  );
  await service.query(
    `insert into use_cases (id, tenant_id, kind, purpose, enabled, config) values ($1, $2, 'lead_callback', 'service', true, '{"defaultLocale":"en-IN"}'), ($3, $2, 'cod_confirm', 'transactional', true, '{}'), ($4, $2, 'abandoned_cart', 'promotional', true, '{}'), ($5, $2, 'appointment_confirm', 'service', true, '{}')`,
    [newId('useCase'), TENANT, newId('useCase'), newId('useCase'), newId('useCase')],
  );
  const insertKey = (
    k: ReturnType<typeof generateApiKey>,
    kind: 'secret' | 'public',
    scopes: string[],
    extra = '',
  ) =>
    service.query(
      `insert into api_keys (id, tenant_id, name, kind, key_hash, prefix, scopes, allowed_domains, daily_cap, revoked_at) values ($1, $2, 'k', $3, $4, $5, $6, $7, $8, $9)`,
      [
        newId('apiKey'),
        TENANT,
        kind,
        k.keyHash,
        k.prefix,
        scopes,
        kind === 'public' ? ['client-b.example'] : null,
        extra === 'cap1' ? 1 : null,
        extra === 'revoked' ? new Date() : null,
      ],
    );
  await insertKey(secretKey, 'secret', [
    'intents:create',
    'intents:read',
    'consents:write',
    'suppressions:write',
    'calls:read',
    'webhooks:read',
    'webhooks:write',
    'support:read',
    'support:write',
    'tickets:read',
    'tickets:write',
    'orders:write',
    'complaints:write',
    'complaints:read',
    'privacy:write',
    'privacy:read',
    'billing:read',
    'billing:write',
    'carts:write',
    'appointments:read',
    'appointments:write',
  ]);
  await insertKey(publicKey, 'public', ['intents:create']);
  await insertKey(revokedKey, 'secret', ['intents:create'], 'revoked');
  await insertKey(narrowKey, 'secret', ['intents:create'], 'cap1');

  const conn = createDb({ url: pg.urls.app, max: 3 });
  db = conn.db;
  closeDb = conn.close;
  app = await buildServer({
    db,
    redis,
    keys: { hashKey: HASH_KEY, encPublicKeyPem: keyPair.publicKeyPem, encKid: 1 },
    staffKey: { publicKeyPem: staffPair.publicKeyPem, kid: 1 },
    razorpay: {
      createSubscription: async (input) => ({
        id: 'sub_APITEST1',
        planId: input.planId,
        status: 'created',
        shortUrl: 'https://rzp.io/i/api',
        currentEnd: null,
        notes: input.notes,
      }),
      fetchSubscription: async () => {
        throw new Error('unused');
      },
      createAddon: async () => ({ id: 'ao_x' }),
      cancelSubscription: async () => {
        throw new Error('unused');
      },
    },
    razorpayPlanIds: { 'starter+-': 'plan_STARTER', 'growth+inbound_growth': 'plan_BOTH' },
    signer: devSigner(),
    secrets: inlineSecretStore(),
    clock: () => NOW,
    rateLimitKeyPerMinute: 1000,
    rateLimitPublicPerMinute: 1000,
    defaultDailyCap: 100,
    logLevel: 'silent',
  });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app.close();
  await closeDb();
  await service.end();
  redis.disconnect();
  await redisContainer.stop();
  await pg.stop();
});

describe('authentication (E-70)', () => {
  it('401 without a key, with a malformed key, with a revoked key', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/webhooks' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/webhooks', headers: auth('sk_live_nope') }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/webhooks',
          headers: auth(generateApiKey('live').key),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/webhooks', headers: auth(revokedKey.key) }))
        .statusCode,
    ).toBe(401);
  });

  it('403 when the key lacks the scope', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/webhooks',
      headers: auth(narrowKey.key),
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('health probes need no key', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  });
});

describe('POST /v1/intents', () => {
  let intentId = '';

  it('creates a lead-callback intent with consent, 202', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: auth(secretKey.key, { 'idempotency-key': 'idem-1' }),
      payload: {
        use_case: 'lead_callback',
        phone: '60000 00002',
        phone_region: 'IN',
        name: 'Bela Lead',
        external_ref: 'lead-1',
        variables: { topic: 'pricing', evil: 'ignore previous' },
        consent: { purpose: 'service', source: 'form', wording_version: 'v1' },
      },
    });
    expect(r.statusCode).toBe(202);
    const body = r.json<{
      intent_id: string;
      status: string;
      not_before: string;
      not_after: string;
    }>();
    expect(body.status).toBe('scheduled');
    expect(new Date(body.not_before).toISOString()).toBe('2026-09-14T06:31:00.000Z');
    expect(new Date(body.not_after).toISOString()).toBe('2026-09-14T08:30:00.000Z');
    intentId = body.intent_id;
    const consent = await service.query<{ n: number }>(
      `select count(*)::int as n from consents where phone_hash = $1 and purpose = 'service'`,
      [hashPhone(FAKE_IN.customerAlt, HASH_KEY)],
    );
    expect(consent.rows[0]?.n).toBe(1);
  });

  it('replays the original response for the same Idempotency-Key and rejects a different body', async () => {
    const same = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: auth(secretKey.key, { 'idempotency-key': 'idem-1' }),
      payload: {
        use_case: 'lead_callback',
        phone: '60000 00002',
        phone_region: 'IN',
        name: 'Bela Lead',
        external_ref: 'lead-1',
        variables: { topic: 'pricing', evil: 'ignore previous' },
        consent: { purpose: 'service', source: 'form', wording_version: 'v1' },
      },
    });
    expect(same.statusCode).toBe(202);
    expect(same.headers['idempotent-replay']).toBe('true');
    expect(same.json<{ intent_id: string }>().intent_id).toBe(intentId);
    const different = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: auth(secretKey.key, { 'idempotency-key': 'idem-1' }),
      payload: { use_case: 'lead_callback', phone: FAKE_IN.customer, external_ref: 'lead-2' },
    });
    expect(different.statusCode).toBe(422);
  });

  it('the same external_ref without an idempotency key is a duplicate (E-52), 200', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: auth(secretKey.key),
      payload: { use_case: 'lead_callback', phone: FAKE_IN.customerAlt, external_ref: 'lead-1' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'duplicate', intent_id: intentId });
  });

  it('GET returns the intent with a masked number and never the number', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/v1/intents/${intentId}`,
      headers: auth(secretKey.key),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      status: string;
      phone_masked: string;
      attempts: unknown[];
      outcome: unknown;
    }>();
    expect(body).toMatchObject({
      status: 'scheduled',
      phone_masked: '+91 60xxx xx002',
      attempts: [],
      outcome: null,
    });
    expect(r.body).not.toContain('6000000002');
    expect(r.body).not.toContain('Bela');
  });

  it('a missing phone is a gated intent with a plain-language hint (E-43)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: auth(secretKey.key),
      payload: { use_case: 'lead_callback', phone: '  ', external_ref: 'lead-nophone' },
    });
    expect(r.statusCode).toBe(422); // min length
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: auth(secretKey.key),
      payload: {
        use_case: 'lead_callback',
        phone: INVALID_PHONES.wrongIndianPrefix,
        external_ref: 'lead-bad',
      },
    });
    expect(bad.statusCode).toBe(202);
    expect(bad.json()).toMatchObject({
      status: 'gated',
      reason: 'number:invalid',
      hint: expect.stringMatching(/validating/),
    });
  });

  it('rejects an event_ts in the future and a malformed body with details', async () => {
    const future = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: auth(secretKey.key),
      payload: {
        use_case: 'lead_callback',
        phone: FAKE_IN.customer,
        external_ref: 'x',
        event_ts: '2030-01-01T00:00:00Z',
      },
    });
    expect(future.statusCode).toBe(422);
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: auth(secretKey.key),
      payload: { use_case: 'teleport', phone: FAKE_IN.customer },
    });
    expect(malformed.statusCode).toBe(422);
    expect(
      malformed.json<{ error: { details: { path: string }[] } }>().error.details.map((d) => d.path),
    ).toEqual(expect.arrayContaining(['use_case', 'external_ref']));
  });

  it('cancel: 200 cancelled, then 200 not-cancelled, then 404 for a stranger', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/cancel`,
      headers: auth(secretKey.key),
    });
    expect(r.json()).toMatchObject({ status: 'cancelled', cancelled: true });
    const again = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/cancel`,
      headers: auth(secretKey.key),
    });
    expect(again.json()).toMatchObject({ status: 'cancelled', cancelled: false });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/intents/${newId('intent')}/cancel`,
          headers: auth(secretKey.key),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('E-70: the per-key daily cap', async () => {
    const one = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: auth(narrowKey.key),
      payload: { use_case: 'lead_callback', phone: FAKE_IN.dnd, external_ref: 'cap-1' },
    });
    expect(one.statusCode).toBe(202);
    const two = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: auth(narrowKey.key),
      payload: { use_case: 'lead_callback', phone: FAKE_IN.dnd, external_ref: 'cap-2' },
    });
    expect(two.statusCode).toBe(429);
    expect(two.headers['retry-after']).toBeDefined();
  });
});

describe('public site keys (SPEC §9.2)', () => {
  it('require an allowed Origin and may only create lead_callback intents', async () => {
    const noOrigin = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: auth(publicKey.key),
      payload: { use_case: 'lead_callback', phone: FAKE_IN.customer, external_ref: 'pk-1' },
    });
    expect(noOrigin.statusCode).toBe(403);
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: auth(publicKey.key, { origin: 'https://evil.example' }),
      payload: { use_case: 'lead_callback', phone: FAKE_IN.customer, external_ref: 'pk-1' },
    });
    expect(badOrigin.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: auth(publicKey.key, { origin: 'https://shop.client-b.example' }),
      payload: { use_case: 'lead_callback', phone: FAKE_IN.customer, external_ref: 'pk-1' },
    });
    expect(ok.statusCode).toBe(202);
    // naaradh.js runs in the merchant's page: the response is readable there (CORS)…
    expect(ok.headers['access-control-allow-origin']).toBe('https://shop.client-b.example');
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/intents',
      headers: { origin: 'https://shop.client-b.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toContain('authorization');
    // …but a refused origin gets no CORS header, and secret keys never do.
    expect(badOrigin.headers['access-control-allow-origin']).toBeUndefined();
    const cod = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: auth(publicKey.key, { origin: 'https://client-b.example' }),
      payload: { use_case: 'cod_confirm', phone: FAKE_IN.customer, external_ref: 'pk-2' },
    });
    expect(cod.statusCode).toBe(403);
  });
});

describe('consents and suppressions', () => {
  it('records consent with the region expiry; an attestation is recorded but flagged insufficient (E-08)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/consents',
      headers: auth(secretKey.key),
      payload: {
        phone: FAKE_IN.customer,
        purpose: 'promotional',
        source: 'form',
        wording_version: 'v2',
      },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      sufficient_for_promotional: true,
      expires_at: '2026-09-21T06:30:00.000Z',
    });
    const att = await app.inject({
      method: 'POST',
      url: '/v1/consents',
      headers: auth(secretKey.key),
      payload: { phone: FAKE_IN.customer, purpose: 'promotional', source: 'attestation' },
    });
    expect(att.json()).toMatchObject({ sufficient_for_promotional: false });
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/consents',
      headers: auth(secretKey.key),
      payload: { phone: 'not a phone', purpose: 'promotional', source: 'form' },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('revokes consent', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: '/v1/consents',
      headers: auth(secretKey.key),
      payload: { phone: FAKE_IN.customer, purpose: 'all' },
    });
    expect(r.json()).toEqual({ revoked: 2 });
  });

  it('suppresses idempotently (201 then 200) and emits the merchant event', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/suppressions',
      headers: auth(secretKey.key),
      payload: { phone: FAKE_IN.optedOut, reason: 'opt_out' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ created: true, until: '2026-12-13T06:30:00.000Z' });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/suppressions',
      headers: auth(secretKey.key),
      payload: { phone: FAKE_IN.optedOut, reason: 'opt_out' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ created: false });
  });
});

describe('webhooks and recordings', () => {
  let webhookId = '';

  it('creates an endpoint, returns the secret once, lists, deletes', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(secretKey.key),
      payload: {
        url: 'https://client-b.example/naaradh',
        events: ['outcome.final', 'intent.gated'],
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json<{ webhook_id: string; secret: string }>();
    expect(body.secret).toMatch(/^whsec_/);
    webhookId = body.webhook_id;
    const stored = await service.query<{ secret_ref: string }>(
      `select secret_ref from merchant_webhooks where id = $1`,
      [webhookId],
    );
    expect(stored.rows[0]?.secret_ref).toBe(`inline:${body.secret}`);
    const list = await app.inject({
      method: 'GET',
      url: '/v1/webhooks',
      headers: auth(secretKey.key),
    });
    expect(
      list.json<{ webhooks: { webhook_id: string }[] }>().webhooks.map((w) => w.webhook_id),
    ).toContain(webhookId);
    expect(list.body).not.toContain(body.secret);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/webhooks/${webhookId}`,
          headers: auth(secretKey.key),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/webhooks/${webhookId}`,
          headers: auth(secretKey.key),
        })
      ).statusCode,
    ).toBe(404);
    const http = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(secretKey.key),
      payload: { url: 'http://insecure.example/x', events: ['outcome.final'] },
    });
    expect(http.statusCode).toBe(422);
  });

  it('recording: 404 for an unknown call, signed URL + audit for a known one', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/calls/${newId('attempt')}/recording`,
          headers: auth(secretKey.key),
        })
      ).statusCode,
    ).toBe(404);
    const attemptId = newId('attempt');
    const intent = await service.query<{ id: string; contact_id: string; phone_hash: string }>(
      `select id, contact_id, phone_hash from call_intents where tenant_id = $1 limit 1`,
      [TENANT],
    );
    const i = intent.rows[0];
    if (i === undefined) throw new Error('no intent');
    await service.query(
      `insert into call_attempts (id, tenant_id, intent_id, contact_id, phone_hash, purpose, attempt_no, engine, from_e164, amd_mode, max_duration_sec, idempotency_key, status, recording_uri)
       values ($1, $2, $3, $4, $5, 'service', 1, 'simulator', $6, 'continue', 180, $1, 'ENDED', 'gs://naaradh-test/x/y/recording.mp3')`,
      [attemptId, TENANT, i.id, i.contact_id, i.phone_hash, FAKE_IN.merchant],
    );
    const r = await app.inject({
      method: 'GET',
      url: `/v1/calls/${attemptId}/recording`,
      headers: auth(secretKey.key),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ url: string }>().url).toMatch(/signed=dev/);
    const audited = await service.query<{ n: number }>(
      `select count(*)::int as n from audit_log where action = 'recording.accessed' and target_id = $1`,
      [attemptId],
    );
    expect(audited.rows[0]?.n).toBe(1);
  });
});

describe('rate limiting', () => {
  it('429 past the per-key limit', async () => {
    const tight = await buildServer({
      db,
      redis,
      keys: { hashKey: HASH_KEY, encPublicKeyPem: keyPair.publicKeyPem, encKid: 1 },
      staffKey: { publicKeyPem: staffPair.publicKeyPem, kid: 1 },
      signer: devSigner(),
      secrets: inlineSecretStore(),
      clock: () => NOW,
      rateLimitKeyPerMinute: 2,
      rateLimitPublicPerMinute: 2,
      defaultDailyCap: 100,
      logLevel: 'silent',
    });
    await tight.ready();
    const codes: number[] = [];
    for (let i = 0; i < 3; i += 1)
      codes.push(
        (await tight.inject({ method: 'GET', url: '/v1/webhooks', headers: auth(secretKey.key) }))
          .statusCode,
      );
    expect(codes).toEqual([200, 200, 429]);
    await tight.close();
  });
});

describe('support line configuration (ADR-0006)', () => {
  const hours = { zone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5, 6], open: '10:00', close: '19:00' };
  const profile = (o: Record<string, unknown> = {}) => ({
    name: 'Support',
    locale: 'en-IN',
    greeting: DEFAULT_INBOUND_GREETINGS['en-IN'],
    tools_enabled: ['lookup_orders', 'verify_caller', 'search_knowledge', 'transfer_to_human'],
    closed_message: DEFAULT_CLOSED_MESSAGES['en-IN'],
    business_hours: hours,
    ...o,
  });
  const post = (url: string, payload: unknown, key = secretKey.key) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as Record<string, unknown>,
      headers: auth(key),
    });
  let targetId = '';

  it('scopes: a key without support:* cannot read or change the support line', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/inbound-profiles',
          headers: auth(narrowKey.key),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await post(
          '/v1/transfer-targets',
          { label: 'x', phone: FAKE_IN.transferTarget },
          narrowKey.key,
        )
      ).statusCode,
    ).toBe(403);
  });

  it('transfer targets: stored with the STAFF key, masked in every response, not transferable until verified (E-86)', async () => {
    const r = await post('/v1/transfer-targets', {
      label: 'Store manager',
      phone: FAKE_IN.transferTarget,
      hours,
    });
    expect(r.statusCode).toBe(201);
    const body = r.json<{ id: string; phone: string; verified: boolean }>();
    targetId = body.id;
    expect(body.verified).toBe(false);
    expect(r.body).not.toContain(FAKE_IN.transferTarget);
    const [row] = (
      await service.query<{ phone_enc: Buffer; verified_at: Date | null }>(
        `select phone_enc, verified_at from transfer_targets where id = $1`,
        [targetId],
      )
    ).rows;
    expect(row?.verified_at).toBeNull();
    expect(decryptPhone(row?.phone_enc ?? Buffer.alloc(0), staffPair.privateKeyPem)).toBe(
      FAKE_IN.transferTarget,
    );
    expect(() => decryptPhone(row?.phone_enc ?? Buffer.alloc(0), keyPair.privateKeyPem)).toThrow();

    const lazy = await post(`/v1/transfer-targets/${targetId}/verify`, {
      attested_by: 'Owner',
      role: 'owner',
      statement: 'yes',
    });
    expect(lazy.statusCode).toBe(422);
    const v = await post(`/v1/transfer-targets/${targetId}/verify`, {
      attested_by: 'Asha (owner)',
      role: 'owner',
      statement: 'I confirm this number belongs to our staff and may receive customer calls.',
    });
    expect(v.statusCode).toBe(200);
    const audit = (
      await service.query<{ after: { method: string } }>(
        `select after from audit_log where action = 'transfer_target.verified' and target_id = $1`,
        [targetId],
      )
    ).rows;
    expect(audit[0]?.after.method).toBe('attestation');
  });

  it('profiles: a greeting without the AI + recording disclosure is refused (invariant 7); a valid one starts as draft', async () => {
    const bad = await post(
      '/v1/inbound-profiles',
      profile({ greeting: 'Hello, thanks for calling {{brand}}, how can I help?' }),
    );
    expect(bad.statusCode).toBe(422);
    expect(bad.body).toContain('disclosure_ai_missing');
    const unknownTool = await post(
      '/v1/inbound-profiles',
      profile({ tools_enabled: ['lookup_orders', 'refund_money'] }),
    );
    expect(unknownTool.statusCode).toBe(422);
    const foreignTarget = await post(
      '/v1/inbound-profiles',
      profile({ transfer_target_id: newId('transferTarget') }),
    );
    expect(foreignTarget.statusCode).toBe(422);

    const r = await post(
      '/v1/inbound-profiles',
      profile({ transfer_target_id: targetId, fallback_forward: { phone: FAKE_IN.merchant } }),
    );
    expect(r.statusCode).toBe(201);
    const { id, status } = r.json<{ id: string; status: string }>();
    expect(status).toBe('draft');
    const act = await post(`/v1/inbound-profiles/${id}/activate`, undefined);
    expect(act.json()).toEqual({ id, status: 'active' });
    const list = await app.inject({
      method: 'GET',
      url: '/v1/inbound-profiles',
      headers: auth(secretKey.key),
    });
    expect(list.body).not.toContain(FAKE_IN.merchant);
    expect(
      list.json<{ data: { agent_cancel_enabled: boolean; fallback_forward: string }[] }>().data[0],
    ).toMatchObject({ agent_cancel_enabled: false });
  });

  it('knowledge: created as draft unless published; merchant text is sanitised', async () => {
    const rlo = String.fromCharCode(0x202e);
    const r = await post('/v1/knowledge', {
      title: `Returns${rlo}`,
      body: 'Unused items within 7 days.',
      status: 'published',
    });
    expect(r.statusCode).toBe(201);
    const [row] = (
      await service.query<{ title: string; status: string }>(
        `select title, status from knowledge_articles where id = $1`,
        [r.json<{ id: string }>().id],
      )
    ).rows;
    expect(row).toEqual({ title: 'Returns', status: 'published' });
  });

  it('orders: API merchants push the cache; a stale update never overwrites a newer one; DELETE erases', async () => {
    const put = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: '/v1/orders/B-77', payload, headers: auth(secretKey.key) });
    const base = {
      name: '#B-77',
      phone: FAKE_IN.customer,
      pincode: '110001',
      payment: 'cod',
      total_minor: 99900,
      currency: 'INR',
      placed_at: '2026-09-14T05:00:00Z',
    };
    expect(
      (
        await put({ ...base, fulfillment_status: 'shipped', updated_at: '2026-09-14T06:00:00Z' })
      ).json(),
    ).toMatchObject({ applied: true });
    expect(
      (await put({ ...base, fulfillment_status: null, updated_at: '2026-09-14T05:30:00Z' })).json(),
    ).toMatchObject({ applied: false });
    const [row] = (
      await service.query<{ fulfillment_status: string; phone_hash: string; name_key: string }>(
        `select fulfillment_status, phone_hash, name_key from orders where external_id = 'B-77'`,
      )
    ).rows;
    expect(row).toEqual({
      fulfillment_status: 'shipped',
      phone_hash: hashPhone(FAKE_IN.customer, HASH_KEY),
      name_key: 'b77',
    });
    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/orders/B-77',
      headers: auth(secretKey.key),
    });
    expect(del.json()).toEqual({ erased: 1 });
    const [gone] = (
      await service.query<{ phone_hash: string | null; erased_at: Date | null }>(
        `select phone_hash, erased_at from orders where external_id = 'B-77'`,
      )
    ).rows;
    expect(gone?.phone_hash).toBeNull();
    expect(gone?.erased_at).not.toBeNull();
    // An erased order is never re-created by a late update.
    expect((await put({ ...base, updated_at: '2026-09-14T07:00:00Z' })).json()).toMatchObject({
      applied: false,
    });
  });

  it('tickets: listed by priority and resolved with an audit row and a merchant event', async () => {
    const id = newId('ticket');
    await service.query(
      `insert into support_tickets (id, tenant_id, category, summary, source, priority) values ($1, $2, 'refund', 'Refund for #1001 requested on a call', 'agent', 80)`,
      [id, TENANT],
    );
    const list = await app.inject({
      method: 'GET',
      url: '/v1/tickets?status=open',
      headers: auth(secretKey.key),
    });
    expect(list.json<{ data: { id: string }[] }>().data.map((t) => t.id)).toContain(id);
    const r = await post(`/v1/tickets/${id}/resolve`, { resolution: 'Refunded via Razorpay' });
    expect(r.json()).toMatchObject({ id, status: 'resolved' });
    const events = (
      await service.query(
        `select 1 from audit_log where action = 'ticket.resolved' and target_id = $1`,
        [id],
      )
    ).rows;
    expect(events).toHaveLength(1);
  });
});

describe('privacy + complaints (P2-CMP-1…3)', () => {
  const dnc = (payload: Record<string, unknown>, ip = '203.0.113.7') =>
    app.inject({
      method: 'POST',
      url: '/v1/public/dnc',
      payload,
      headers: { 'content-type': 'application/json' },
      remoteAddress: ip,
    });

  it('public /do-not-call: no key needed, a global indefinite suppression, idempotent, same answer every time', async () => {
    const r1 = await dnc({ phone: FAKE_IN.dnd });
    expect(r1.statusCode).toBe(202);
    const r2 = await dnc({ phone: FAKE_IN.dnd });
    expect(r2.statusCode).toBe(202);
    expect(r2.body).toBe(r1.body);
    const rows = (
      await service.query<{
        tenant_id: string | null;
        reason: string;
        until: Date | null;
        purpose: string;
      }>(
        `select tenant_id, reason, until, purpose from suppressions where phone_hash = $1 and lifted_at is null`,
        [hashPhone(FAKE_IN.dnd, HASH_KEY)],
      )
    ).rows;
    expect(rows).toEqual([
      { tenant_id: null, reason: 'self_service', until: null, purpose: 'all' },
    ]);
    const audit = (
      await service.query<{ ip_hash: string | null; target_id: string }>(
        `select ip_hash, target_id from audit_log where action = 'dnc.requested'`,
      )
    ).rows;
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit[0]?.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(audit)).not.toContain('203.0.113.7');
  });

  it('public /do-not-call: reporting an unwanted call queues an unattributed complaint report; bad input is refused', async () => {
    expect((await dnc({ phone: FAKE_IN.customerAlt, report_unwanted_call: true })).statusCode).toBe(
      202,
    );
    const reports = (
      await service.query<{
        tenant_id: string | null;
        source: string;
        status: string;
        reporter: string;
      }>(
        `select tenant_id, source, status, reporter from complaint_reports where phone_hash = $1`,
        [hashPhone(FAKE_IN.customerAlt, HASH_KEY)],
      )
    ).rows;
    expect(reports).toEqual([
      { tenant_id: null, source: 'self_service', status: 'pending', reporter: 'dnc_page' },
    ]);
    expect((await dnc({ phone: INVALID_PHONES.tooShort })).statusCode).toBe(422);
    expect((await dnc({ phone: FAKE_IN.customer, erase: true })).statusCode).toBe(422);
  });

  it('public /do-not-call: at most 3 requests per number per day', async () => {
    const phone = FAKE_IN.landline;
    for (let i = 0; i < 3; i += 1)
      expect((await dnc({ phone }, `198.51.100.${String(i)}`)).statusCode).not.toBe(429);
    expect((await dnc({ phone }, '198.51.100.9')).statusCode).toBe(429);
  });

  it('merchant complaints: queued for attribution under the tenant; scope enforced', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/complaints',
      payload: { phone: FAKE_IN.customer, notes: 'customer says we called 5 times' },
      headers: auth(secretKey.key),
    });
    expect(r.statusCode).toBe(202);
    const { report_id } = r.json<{ report_id: string }>();
    const [row] = (
      await service.query<{ tenant_id: string; source: string }>(
        `select tenant_id, source from complaint_reports where id = $1`,
        [report_id],
      )
    ).rows;
    expect(row).toEqual({ tenant_id: TENANT, source: 'merchant' });
    const list = await app.inject({
      method: 'GET',
      url: '/v1/complaints',
      headers: auth(secretKey.key),
    });
    expect(
      list.json<{ pending_reports: { id: string }[] }>().pending_reports.map((p) => p.id),
    ).toContain(report_id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/complaints',
          payload: { phone: FAKE_IN.customer },
          headers: auth(narrowKey.key),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('merchant erasure requests: due in 30 days, readable by id, invisible to other tenants', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/erasure-requests',
      payload: { phone: FAKE_IN.customer },
      headers: auth(secretKey.key),
    });
    expect(r.statusCode).toBe(202);
    const { id, due_at } = r.json<{ id: string; due_at: string }>();
    expect(new Date(due_at).getTime() - NOW.getTime()).toBe(30 * 86_400_000);
    const get = await app.inject({
      method: 'GET',
      url: `/v1/erasure-requests/${id}`,
      headers: auth(secretKey.key),
    });
    expect(get.json()).toMatchObject({ id, status: 'requested' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/erasure-requests/${newId('erasure')}`,
          headers: auth(secretKey.key),
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('billing routes (ADR-0008)', () => {
  it('GET /v1/billing: the plan, allowance and usage for this period', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/billing', headers: auth(secretKey.key) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      period: '2026-09',
      currency: 'INR',
      outbound: { used: 0 },
      inbound: { used: 0 },
    });
  });

  it('Razorpay subscribe: a pending subscription and the mandate URL; an offered combination only; never for a Shopify store', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/billing/razorpay/subscribe',
      payload: { plan_code: 'starter' },
      headers: auth(secretKey.key),
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: 'pending', authorize_url: 'https://rzp.io/i/api' });
    const [row] = (
      await service.query<{
        provider: string;
        status: string;
        plan_code: string;
        recurring_minor: string;
      }>(
        `select provider, status, plan_code, recurring_minor from billing_subscriptions where tenant_id = $1`,
        [TENANT],
      )
    ).rows;
    expect(row).toEqual({
      provider: 'razorpay',
      status: 'pending',
      plan_code: 'starter',
      recurring_minor: '199900',
    });
    // The plan is NOT applied until Razorpay confirms (worker re-fetch).
    const [t] = (
      await service.query<{ plan_code: string | null; billing_status: string }>(
        `select plan_code, billing_status from tenants where id = $1`,
        [TENANT],
      )
    ).rows;
    expect(t?.plan_code).not.toBe('starter');

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/billing/razorpay/subscribe',
          payload: { plan_code: 'scale' },
          headers: auth(secretKey.key),
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/billing/razorpay/subscribe',
          payload: { plan_code: 'no_such_plan' },
          headers: auth(secretKey.key),
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/billing/razorpay/subscribe',
          payload: {},
          headers: auth(secretKey.key),
        })
      ).statusCode,
    ).toBe(422);

    await service.query(
      `insert into integrations (id, tenant_id, kind, external_id) values ($1, $2, 'shopify', 'api-billing-test.myshopify.com')`,
      [newId('integration'), TENANT],
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/billing/razorpay/subscribe',
          payload: { plan_code: 'starter' },
          headers: auth(secretKey.key),
        })
      ).statusCode,
    ).toBe(403);
    await service.query(
      `update integrations set status = 'uninstalled' where external_id = 'api-billing-test.myshopify.com'`,
    );
  });

  it('pricing is not merchant-editable: the app role cannot touch plan or overrides', async () => {
    const app_ = new RoleClient(pg.urls.app);
    await expect(
      app_.inTenant(TENANT, (c) =>
        c.query(
          `update tenants set billing_overrides = '{"outcome_unit_minor": 1}' where id = $1`,
          [TENANT],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app_.inTenant(TENANT, (c) =>
        c.query(`update tenants set inbound_plan_code = 'inbound_scale' where id = $1`, [TENANT]),
      ),
    ).rejects.toThrow(/permission denied/);
    await app_.end();
  });

  it('disputes: a missing outcome is 404; the list is scoped', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/v1/outcomes/${newId('outcome')}/disputes`,
      payload: { reason: 'the customer never picked up the phone' },
      headers: auth(secretKey.key),
    });
    expect(r.statusCode).toBe(404);
    const list = await app.inject({
      method: 'GET',
      url: '/v1/disputes',
      headers: auth(secretKey.key),
    });
    expect(list.json()).toEqual({ data: [] });
  });
});

describe('carts and appointments for non-Shopify platforms (ADR-0011)', () => {
  const cart = (over: Record<string, unknown> = {}) => ({
    phone: FAKE_IN.customer,
    name: 'Asha',
    value_minor: 129900,
    currency: 'INR',
    item_summary: '2 items',
    item_count: 2,
    consent_wording_version: '2026-09-v1-draft',
    created_at: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    ...over,
  });

  it('records a cart with consent and reports the wording version it recognises', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/v1/carts/woo-cart-1',
      payload: cart(),
      headers: auth(secretKey.key),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      cart_ref: 'woo-cart-1',
      status: 'open',
      consent: 'granted',
      current_consent_wording_version: '2026-09-v1-draft',
    });
    // One grant from this cart, with the wording version — earlier tests in this file made
    // their own consents for the same number from other sources.
    const consents = await service.query<{ wording_version: string; purpose: string }>(
      `select wording_version, purpose from consents
       where tenant_id = $1 and phone_hash = $2 and source = 'checkout' and external_ref = 'woo-cart-1'`,
      [TENANT, hashPhone(FAKE_IN.customer, HASH_KEY)],
    );
    expect(consents.rows).toEqual([
      { wording_version: '2026-09-v1-draft', purpose: 'promotional' },
    ]);
  });

  it('E-121: a cart without the box ticked is recorded for the funnel and never called', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/v1/carts/woo-cart-2',
      payload: cart({ phone: FAKE_IN.customerAlt, consent_wording_version: null }),
      headers: auth(secretKey.key),
    });
    expect(r.json()).toMatchObject({ status: 'open', consent: 'unchanged' });
    const stored = await service.query<{ consent_wording: string | null }>(
      `select consent_wording from checkouts where tenant_id = $1 and external_id = 'woo-cart-2'`,
      [TENANT],
    );
    expect(stored.rows[0]?.consent_wording).toBeNull();
  });

  it('E-106: a wording version Naaradh never published is not consent', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/v1/carts/woo-cart-3',
      payload: cart({ phone: '+916000000061', consent_wording_version: 'we-wrote-our-own' }),
      headers: auth(secretKey.key),
    });
    expect(r.json()).toMatchObject({ consent: 'unknown_wording' });
    const consents = await service.query(
      `select 1 from consents where tenant_id = $1 and phone_hash = $2`,
      [TENANT, hashPhone('+916000000061', HASH_KEY)],
    );
    expect(consents.rows).toHaveLength(0);
  });

  it('refuses a cart started in the future, and a ref that is not a string', async () => {
    const future = await app.inject({
      method: 'PUT',
      url: '/v1/carts/woo-cart-4',
      payload: cart({ created_at: new Date(NOW.getTime() + 10 * 60_000).toISOString() }),
      headers: auth(secretKey.key),
    });
    expect(future.statusCode).toBe(422);
    const bad = await app.inject({
      method: 'PUT',
      url: '/v1/carts/woo-cart-5',
      payload: { ...cart(), value_minor: -1 },
      headers: auth(secretKey.key),
    });
    expect(bad.statusCode).toBe(422);
  });

  it('GET reports what Naaradh decided; completing cancels the recovery call (E-123)', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/v1/carts/woo-cart-1',
      headers: auth(secretKey.key),
    });
    expect(before.json()).toMatchObject({ status: 'open', intent_id: null, reason: null });

    const done = await app.inject({
      method: 'POST',
      url: '/v1/carts/woo-cart-1/completed',
      payload: { order_ref: null },
      headers: auth(secretKey.key),
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'completed' });
    const after = await app.inject({
      method: 'GET',
      url: '/v1/carts/woo-cart-1',
      headers: auth(secretKey.key),
    });
    expect(after.json()).toMatchObject({ status: 'converted' });

    const missing = await app.inject({
      method: 'POST',
      url: '/v1/carts/nope/completed',
      payload: {},
      headers: auth(secretKey.key),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('a key without carts:write cannot report a cart', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/v1/carts/woo-cart-9',
      payload: cart(),
      headers: auth(narrowKey.key),
    });
    expect(r.statusCode).toBe(403);
  });

  it('records an appointment, moves it, cancels it, and lists it', async () => {
    const starts = new Date(NOW.getTime() + 30 * 3_600_000).toISOString();
    const created = await app.inject({
      method: 'PUT',
      url: '/v1/appointments/lab-77',
      payload: {
        phone: FAKE_IN.customer,
        name: 'Asha',
        service: 'Blood test',
        starts_at: starts,
        timezone: 'Asia/Kolkata',
      },
      headers: auth(secretKey.key),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ appointment_id: string }>().appointment_id;
    expect(id).toMatch(/^apt_/);

    const moved = new Date(NOW.getTime() + 40 * 3_600_000).toISOString();
    const update = await app.inject({
      method: 'PUT',
      url: '/v1/appointments/lab-77',
      payload: {
        phone: FAKE_IN.customer,
        service: 'Blood test',
        starts_at: moved,
        timezone: 'Asia/Kolkata',
      },
      headers: auth(secretKey.key),
    });
    expect(update.statusCode).toBe(200);
    const read = await app.inject({
      method: 'GET',
      url: '/v1/appointments/lab-77',
      headers: auth(secretKey.key),
    });
    expect(read.json()).toMatchObject({
      appointment_id: id,
      starts_at: moved,
      status: 'scheduled',
      intent_id: null,
    });

    const list = await app.inject({
      method: 'GET',
      url: `/v1/appointments?from=${encodeURIComponent(NOW.toISOString())}`,
      headers: auth(secretKey.key),
    });
    expect(list.json<{ appointments: unknown[] }>().appointments).toHaveLength(1);

    const cancelled = await app.inject({
      method: 'PUT',
      url: '/v1/appointments/lab-77',
      payload: {
        phone: FAKE_IN.customer,
        starts_at: moved,
        timezone: 'Asia/Kolkata',
        status: 'cancelled',
      },
      headers: auth(secretKey.key),
    });
    expect(cancelled.statusCode).toBe(200);
    const afterCancel = await app.inject({
      method: 'GET',
      url: '/v1/appointments/lab-77',
      headers: auth(secretKey.key),
    });
    expect(afterCancel.json()).toMatchObject({ status: 'cancelled' });
  });

  it('refuses a bad time zone, an end before the start, and an unknown calendar', async () => {
    const base = {
      phone: FAKE_IN.customer,
      starts_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
      timezone: 'Asia/Kolkata',
    };
    const zone = await app.inject({
      method: 'PUT',
      url: '/v1/appointments/bad-1',
      payload: { ...base, timezone: 'Mars/Olympus' },
      headers: auth(secretKey.key),
    });
    expect(zone.statusCode).toBe(422);
    const ends = await app.inject({
      method: 'PUT',
      url: '/v1/appointments/bad-2',
      payload: { ...base, ends_at: NOW.toISOString() },
      headers: auth(secretKey.key),
    });
    expect(ends.statusCode).toBe(422);
    const calendar = await app.inject({
      method: 'PUT',
      url: '/v1/appointments/bad-3',
      payload: { ...base, calendar_id: 'cal_01SEEDNOPE0000000000000000' },
      headers: auth(secretKey.key),
    });
    expect(calendar.statusCode).toBe(404);
  });

  it('an appointment for a number we cannot dial is recorded as skipped, not rejected', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/v1/appointments/no-phone',
      payload: {
        phone: null,
        starts_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
        timezone: 'Asia/Kolkata',
      },
      headers: auth(secretKey.key),
    });
    // Recorded without a contact: the support line can still answer "do I have an appointment?".
    expect(r.statusCode).toBe(201);
    const rows = await service.query<{ phone_hash: string | null }>(
      `select phone_hash from appointments where tenant_id = $1 and external_id = 'no-phone'`,
      [TENANT],
    );
    expect(rows.rows[0]?.phone_hash).toBeNull();
  });

  it('lists connected calendars (read-only for merchants)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/calendars',
      headers: auth(secretKey.key),
    });
    expect(r.json()).toEqual({ calendars: [] });
  });
});
