import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { createDb } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import { hashPhone, newId } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { buildConsole } from '../../src/server.js';
import { isStaff, verifyIapJwt } from '../../src/iap.js';

/**
 * Staff console on real Postgres + Redis: staff-only, same-origin POSTs, and each action writes
 * the durable record and an audit row attributed to staff:<email>.
 */

const ORIGIN = 'https://console.naaradh.test';
const STAFF = 'ops@naaradh.com';
const T = newId('tenant');
const HASH_KEY = 'h'.repeat(32);
const NOW = new Date('2026-09-14T06:30:00Z');

let pg: TestPostgres;
let redisContainer: StartedRedisContainer;
let redis: Redis;
let service: RoleClient;
let app: FastifyInstance;
let close: () => Promise<void>;

const q = async <R extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await service.query<R>(text, params)).rows;

function post(url: string, form: Record<string, string>, origin = ORIGIN) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin, 'x-test-staff': STAFF },
    payload: new URLSearchParams(form).toString(),
  });
}

const get = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-staff': STAFF } });

beforeAll(async () => {
  pg = await startTestPostgres();
  redisContainer = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(redisContainer.getConnectionUrl());
  service = new RoleClient(pg.urls.service);
  await q(
    `insert into tenants (id, name, country, data_region, status, paused_at, paused_reason) values ($1, 'Client A', 'IN', 'in', 'paused', now(), 'complaints:3_in_10d')`,
    [T],
  );
  const s = createDb({ url: pg.urls.service, max: 3 });
  close = s.close;
  app = await buildConsole({
    db: s.db,
    redis,
    clock: () => NOW,
    hashKey: HASH_KEY,
    origin: ORIGIN,
    logLevel: 'silent',
    dashboardUrl: 'https://app.naaradh.test',
    // Tests stand in for IAP with a header; production verifies the IAP JWT (iap.ts).
    authenticate: async (request) => {
      const v = request.headers['x-test-staff'];
      return typeof v === 'string' ? v : null;
    },
    readTranscript: async () => [{ role: 'customer', text: 'haan confirm hai' }],
  });
}, 240_000);

afterAll(async () => {
  await app.close();
  await close();
  await service.end();
  redis.disconnect();
  await redisContainer.stop();
  await pg.stop();
});

describe('access', () => {
  it('refuses anyone who is not verified staff, and cross-origin POSTs', async () => {
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(403);
    expect((await get('/')).statusCode).toBe(200);
    const r = await post(
      `/tenants/${T}/resume`,
      { reason: 'reviewed complaints, all invalid' },
      'https://evil.example',
    );
    expect(r.statusCode).toBe(403);
    expect(
      (await q<{ status: string }>(`select status from tenants where id = $1`, [T]))[0]?.status,
    ).toBe('paused');
    const page = await get('/tenants');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.body).toContain('Client A');
  });

  it('escapes tenant-controlled text', async () => {
    const evil = newId('tenant');
    await q(
      `insert into tenants (id, name, country, data_region) values ($1, '<script>alert(1)</script>', 'IN', 'in')`,
      [evil],
    );
    const page = await get('/tenants');
    expect(page.body).not.toContain('<script>alert(1)</script>');
    expect(page.body).toContain('&lt;script&gt;');
  });
});

describe('actions', () => {
  it('resume needs a reason; a resume is audited as staff', async () => {
    const short = await post(`/tenants/${T}/resume`, { reason: 'ok' });
    expect(short.statusCode).toBe(303);
    expect(
      (await q<{ status: string }>(`select status from tenants where id = $1`, [T]))[0]?.status,
    ).toBe('paused');
    await post(`/tenants/${T}/resume`, { reason: 'reviewed complaints, all invalid' });
    expect(
      (await q<{ status: string }>(`select status from tenants where id = $1`, [T]))[0]?.status,
    ).toBe('active');
    const a = await q<{ actor_id: string }>(
      `select actor_id from audit_log where action = 'tenant.resumed' and tenant_id = $1`,
      [T],
    );
    expect(a[0]?.actor_id).toBe(`staff:${STAFF}`);
  });

  it('kill switch: durable row, Redis hot copy, audit; bad keys refused', async () => {
    await post('/kill-switches', {
      scope: 'tenant',
      key: T,
      active: 'true',
      reason: 'investigating spike',
    });
    const [row] = await q<{ active: boolean; set_by: string }>(
      `select active, set_by from kill_switches where scope = 'tenant' and key = $1`,
      [T],
    );
    expect(row).toEqual({ active: true, set_by: `staff:${STAFF}` });
    expect(await redis.keys('*')).toEqual(expect.arrayContaining([expect.stringContaining(T)]));
    await post('/kill-switches', {
      scope: 'tenant',
      key: T,
      active: 'false',
      reason: 'spike explained',
    });
    expect(await redis.keys(`*${T}*`)).toEqual([]);
    await post('/kill-switches', {
      scope: 'global',
      key: 'everything',
      active: 'true',
      reason: 'bad key here',
    });
    expect((await q(`select 1 from kill_switches where scope = 'global'`)).length).toBe(0);
  });

  it('a global erasure and a global DNC are recorded without storing the number', async () => {
    await post('/privacy/erasure', {
      phone: FAKE_IN.customer,
      region: 'IN',
      reference: 'ticket-1',
    });
    expect((await q(`select 1 from erasure_requests`)).length).toBe(0); // not verified → refused
    await post('/privacy/erasure', {
      phone: FAKE_IN.customer,
      region: 'IN',
      reference: 'ticket-1',
      verified: 'on',
    });
    const [e] = await q<{ tenant_id: string | null; phone_hash: string; source: string }>(
      `select tenant_id, phone_hash, source from erasure_requests`,
    );
    expect(e).toEqual({
      tenant_id: null,
      phone_hash: hashPhone(FAKE_IN.customer, HASH_KEY),
      source: 'email',
    });
    await post('/privacy/dnc', { phone: FAKE_IN.customerAlt, region: 'IN', reference: 'dnc-7' });
    const [sup] = await q<{ tenant_id: string | null; reason: string }>(
      `select tenant_id, reason from suppressions where phone_hash = $1`,
      [hashPhone(FAKE_IN.customerAlt, HASH_KEY)],
    );
    expect(sup).toEqual({ tenant_id: null, reason: 'self_service' });
  });

  it('a dispute decision writes the credit and the transcript read is audited', async () => {
    const uc = newId('useCase');
    const contact = newId('contact');
    const intent = newId('intent');
    const attempt = newId('attempt');
    const outcome = newId('outcome');
    const ledger = newId('ledger');
    const dispute = newId('dispute');
    const ph = hashPhone(FAKE_IN.customer, HASH_KEY);
    await q(
      `insert into use_cases (id, tenant_id, kind, purpose, enabled) values ($1, $2, 'cod_confirm', 'transactional', true)`,
      [uc, T],
    );
    await q(
      `insert into contacts (id, tenant_id, phone_hash, phone_masked, region) values ($1, $2, $3, '+91 60xxx xx001', 'IN')`,
      [contact, T, ph],
    );
    await q(
      `insert into call_intents (id, tenant_id, use_case_id, use_case, purpose, contact_id, phone_hash, recipient_region, source, external_ref, external_refs, event_ts, not_before, not_after, status, locale, idempotency_key)
       values ($1, $2, $3, 'cod_confirm', 'transactional', $4, $5, 'IN', 'shopify', 'o-1', array['o-1'], now(), now(), now() + interval '30 minutes', 'COMPLETED', 'hi-IN', $1)`,
      [intent, T, uc, contact, ph],
    );
    await q(
      `insert into call_attempts (id, tenant_id, intent_id, contact_id, phone_hash, direction, purpose, attempt_no, engine, from_e164, amd_mode, max_duration_sec, idempotency_key, status, answered_by, transcript_uri, answered_at, ai_disclosed_at, recording_disclosed_at, ended_at)
       values ($1, $2, $3, $4, $5, 'outbound', 'transactional', 1, 'simulator', '+916000000100', 'continue', 120, $1, 'ENDED', 'human', 'gs://b/t.json', now(), now(), now(), now())`,
      [attempt, T, intent, contact, ph],
    );
    await q(
      `insert into billing_ledger (id, tenant_id, kind, ref, qty, unit_minor, total_minor, currency, period, provider) values ($1, $2, 'outcome', $3, 1, 800, 800, 'INR', '2026-09', 'razorpay')`,
      [ledger, T, outcome],
    );
    await q(
      `insert into call_outcomes (id, tenant_id, attempt_id, intent_id, outcome, confidence, extraction_method, billable, billable_reason, billed_at, billing_ledger_id)
       values ($1, $2, $3, $4, 'confirmed', 0.95, 'engine', true, 'billable', now(), $5)`,
      [outcome, T, attempt, intent, ledger],
    );
    await q(
      `insert into outcome_disputes (id, tenant_id, outcome_id, opened_by_user_id, reason) values ($1, $2, $3, 'usr_x', 'the person was not our customer')`,
      [dispute, T, outcome],
    );
    const evidence = await get(`/disputes/${dispute}`);
    expect(evidence.body).toContain('haan confirm hai');
    expect(
      (
        await q(`select 1 from audit_log where action = 'transcript.accessed' and target_id = $1`, [
          attempt,
        ])
      ).length,
    ).toBe(1);
    await post(`/disputes/${dispute}/resolve`, {
      decision: 'accepted',
      resolution: 'wrong person answered, per transcript',
    });
    const [credit] = await q<{ total_minor: string }>(
      `select total_minor from billing_ledger where kind = 'credit' and tenant_id = $1`,
      [T],
    );
    expect(Number(credit?.total_minor)).toBe(-800);
    const [d] = await q<{ status: string; resolved_by: string }>(
      `select status, resolved_by from outcome_disputes where id = $1`,
      [dispute],
    );
    expect(d).toEqual({ status: 'accepted', resolved_by: `staff:${STAFF}` });
  });
});

describe('IAP JWT verification', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keys = async () => new Map([['k1', publicKey]]);
  const aud = '/projects/123/global/backendServices/456';
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = (payload: Record<string, unknown>, kid = 'k1') => {
    const head = b64({ alg: 'ES256', kid });
    const body = b64(payload);
    const sig = sign('sha256', Buffer.from(`${head}.${body}`), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${head}.${body}.${sig.toString('base64url')}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const good = {
    iss: 'https://cloud.google.com/iap',
    aud,
    email: 'accounts.google.com:Ops@Naaradh.com',
    iat: now,
    exp: now + 600,
  };

  it('accepts a valid token and normalises the email', async () => {
    expect(await verifyIapJwt(token(good), aud, keys)).toEqual({ email: 'ops@naaradh.com' });
  });

  it('rejects wrong audience, issuer, expiry, key, or a tampered payload', async () => {
    expect(await verifyIapJwt(token({ ...good, aud: '/projects/1/x' }), aud, keys)).toBeNull();
    expect(await verifyIapJwt(token({ ...good, iss: 'https://evil' }), aud, keys)).toBeNull();
    expect(await verifyIapJwt(token({ ...good, exp: now - 3600 }), aud, keys)).toBeNull();
    expect(await verifyIapJwt(token(good, 'unknown'), aud, keys)).toBeNull();
    const [hd, , sg] = token(good).split('.');
    expect(
      await verifyIapJwt(
        `${hd ?? ''}.${b64({ ...good, email: 'x@evil.com' })}.${sg ?? ''}`,
        aud,
        keys,
      ),
    ).toBeNull();
    expect(await verifyIapJwt(undefined, aud, keys)).toBeNull();
  });

  it('staff allow-list: domain or explicit address', () => {
    expect(isStaff('ops@naaradh.com', 'naaradh.com', [])).toBe(true);
    expect(isStaff('ops@naaradh.com.evil.com', 'naaradh.com', [])).toBe(false);
    expect(isStaff('contractor@gmail.com', 'naaradh.com', ['contractor@gmail.com'])).toBe(true);
  });
});

describe('numbers and merchants (P3 go-live gaps)', () => {
  const profile = newId('inboundProfile');

  beforeAll(async () => {
    await q(
      `insert into inbound_profiles (id, tenant_id, name, status, greeting, business_hours, tools_enabled, pinned_facts, closed_message)
       values ($1, $2, 'Support line', 'active', 'Namaste, main Client A ki taraf se automated AI assistant bol rahi hoon. Yeh call record ho rahi hai.',
               '{"zone":"Asia/Kolkata","days":[1,2,3,4,5],"open":"09:00","close":"18:00"}', array['lookup_order'], array[]::text[], 'Hum abhi band hain.')`,
      [profile, T],
    );
  });

  it('registers a pool number as warming, refuses activation without purposes, then activates — all audited as staff', async () => {
    const created = await post('/numbers', {
      e164: FAKE_IN.merchant,
      region: 'IN',
      series: '10digit',
      provider: 'exotel',
      engine: 'simulator',
      provisioning_note: '',
    });
    expect(created.statusCode).toBe(303);
    const [n] = await q<{
      id: string;
      status: string;
      purpose_allowed: string[];
      tenant_id: string | null;
    }>(
      `select id, status, purpose_allowed::text[] as purpose_allowed, tenant_id from numbers where e164 = $1`,
      [FAKE_IN.merchant],
    );
    expect(n).toMatchObject({ status: 'warming', purpose_allowed: [], tenant_id: null });
    expect(created.headers.location).toBe(`/numbers/${n?.id ?? ''}`);

    // No purposes and no inbound profile → nothing it could do; activation refused.
    await post(`/numbers/${n?.id ?? ''}/status`, {
      status: 'active',
      reason: 'TSP letter received',
    });
    expect(
      (await q<{ status: string }>(`select status from numbers where id = $1`, [n?.id]))[0]?.status,
    ).toBe('warming');

    await post(`/numbers/${n?.id ?? ''}/purposes`, {
      purpose_transactional: 'on',
      purpose_service: 'on',
      provisioning_note: 'TSP letter 2026-09-10, docs/legal/tsp-responses/exotel.pdf',
    });
    await post(`/numbers/${n?.id ?? ''}/status`, {
      status: 'active',
      reason: 'TSP letter received, answer URL set',
    });
    const [after] = await q<{ status: string; purpose_allowed: string[] }>(
      `select status, purpose_allowed::text[] as purpose_allowed from numbers where id = $1`,
      [n?.id],
    );
    expect(after).toEqual({ status: 'active', purpose_allowed: ['transactional', 'service'] });
    const actions = await q<{ action: string; actor_id: string }>(
      `select action, actor_id from audit_log where target_id = $1 order by at`,
      [n?.id],
    );
    expect(actions.map((a) => a.action)).toEqual([
      'number.registered',
      'number.purposes_changed',
      'number.active',
    ]);
    expect(new Set(actions.map((a) => a.actor_id))).toEqual(new Set([`staff:${STAFF}`]));
    const page = await get('/numbers');
    expect(page.body).toContain(FAKE_IN.merchant);
    expect(page.body).toContain('transactional, service');
  });

  it('refuses a duplicate, a number outside its region, and a profile of another tenant; assigns a support line', async () => {
    const dup = await post('/numbers', {
      e164: FAKE_IN.merchant,
      series: '10digit',
      provider: 'exotel',
      engine: 'simulator',
    });
    expect(dup.headers.location).toBe('/numbers');
    expect((await q(`select 1 from numbers where e164 = $1`, [FAKE_IN.merchant])).length).toBe(1);

    await post('/numbers', {
      e164: '+12125550100',
      region: 'IN',
      series: 'intl',
      provider: 'twilio',
      engine: 'simulator',
    });
    expect((await q(`select 1 from numbers where e164 = '+12125550100'`)).length).toBe(0);

    const other = newId('tenant');
    await q(
      `insert into tenants (id, name, country, data_region) values ($1, 'Other', 'IN', 'in')`,
      [other],
    );
    await post('/numbers', {
      e164: FAKE_IN.transferTarget,
      series: '10digit',
      provider: 'exotel',
      engine: 'simulator',
      tenant_id: other,
      inbound_profile_id: profile,
      inbound_enabled: 'on',
    });
    expect(
      (await q(`select 1 from numbers where e164 = $1`, [FAKE_IN.transferTarget])).length,
    ).toBe(0);

    await post('/numbers', {
      e164: FAKE_IN.transferTarget,
      series: '10digit',
      provider: 'exotel',
      engine: 'simulator',
      tenant_id: T,
      inbound_profile_id: profile,
      inbound_enabled: 'on',
    });
    const [line] = await q<{
      id: string;
      tenant_id: string;
      inbound_profile_id: string;
      inbound_enabled: boolean;
    }>(`select id, tenant_id, inbound_profile_id, inbound_enabled from numbers where e164 = $1`, [
      FAKE_IN.transferTarget,
    ]);
    expect(line).toMatchObject({
      tenant_id: T,
      inbound_profile_id: profile,
      inbound_enabled: true,
    });
    // A support line needs no outbound purposes to go active.
    await post(`/numbers/${line?.id ?? ''}/status`, {
      status: 'active',
      reason: 'forwarding agreed with merchant',
    });
    expect(
      (await q<{ status: string }>(`select status from numbers where id = $1`, [line?.id]))[0]
        ?.status,
    ).toBe('active');
    // Back to the pool: the profile must go too (database rule), and both tenants get an audit row.
    await post(`/numbers/${line?.id ?? ''}/assign`, {
      tenant_id: '',
      inbound_profile_id: '',
      note: 'merchant churned, number rests',
    });
    const [pool] = await q<{
      tenant_id: string | null;
      inbound_profile_id: string | null;
      inbound_enabled: boolean;
    }>(`select tenant_id, inbound_profile_id, inbound_enabled from numbers where id = $1`, [
      line?.id,
    ]);
    expect(pool).toEqual({ tenant_id: null, inbound_profile_id: null, inbound_enabled: false });
  });

  it('creates a direct merchant with an owner, use cases OFF and draft scripts; the page shows the sign-in URL', async () => {
    const r = await post('/tenants', {
      name: 'Client B',
      legal_name: 'Client B Private Limited',
      country: 'IN',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      gstin: '29abcde1234f1z5',
      pan: '',
      owner_email: 'Owner@Client-B.example',
      owner_name: 'B Owner',
      usecase_cod_confirm: 'on',
      usecase_lead_callback: 'on',
      default_locale: 'en-IN',
      note: 'pilot merchant B, website leads; agreement signed',
    });
    expect(r.statusCode).toBe(303);
    const tenantId = (r.headers.location ?? '').replace('/tenants/', '');
    expect(tenantId).toMatch(/^ten_/);
    const [t] = await q<{ status: string; gstin: string; review_until: Date; data_region: string }>(
      `select status, gstin, review_until, data_region from tenants where id = $1`,
      [tenantId],
    );
    expect(t).toMatchObject({
      status: 'pending_review',
      gstin: '29ABCDE1234F1Z5',
      data_region: 'in',
    });
    expect(t?.review_until.getTime()).toBe(NOW.getTime() + 7 * 86_400_000);
    const users = await q<{ email: string; role: string }>(
      `select email, role from users where tenant_id = $1`,
      [tenantId],
    );
    expect(users).toEqual([{ email: 'owner@client-b.example', role: 'owner' }]);
    const useCases = await q<{ kind: string; enabled: boolean; purpose: string }>(
      `select kind, enabled, purpose from use_cases where tenant_id = $1 order by kind`,
      [tenantId],
    );
    expect(useCases).toEqual([
      { kind: 'cod_confirm', enabled: false, purpose: 'transactional' },
      { kind: 'lead_callback', enabled: false, purpose: 'service' },
    ]);
    const scripts = await q<{ locale: string; status: string }>(
      `select locale, status from scripts where tenant_id = $1 order by locale`,
      [tenantId],
    );
    expect(scripts).toEqual([
      { locale: 'en-IN', status: 'draft' },
      { locale: 'en-IN', status: 'draft' },
      { locale: 'hi-IN', status: 'draft' },
    ]);
    const actions = await q<{ action: string }>(
      `select action from audit_log where tenant_id = $1 and actor_id = $2 order by at`,
      [tenantId, `staff:${STAFF}`],
    );
    expect(actions.map((a) => a.action)).toEqual([
      'tenant.created',
      'user.invited',
      'tenant.default_setup',
    ]);
    // The flash on the next page tells staff where the owner signs in.
    const follow = await app.inject({
      method: 'GET',
      url: r.headers.location ?? '/',
      headers: {
        'x-test-staff': STAFF,
        cookie: (r.headers['set-cookie'] as string).split(';')[0] ?? '',
      },
    });
    expect(follow.body).toContain('sign in at https://app.naaradh.test/login');

    // Shopify stores are not created here; a bad GSTIN is refused before anything is written.
    const bad = await post('/tenants', {
      name: 'Client C',
      owner_email: 'c@client-c.example',
      gstin: 'nope',
      usecase_cod_confirm: 'on',
      note: 'typo in the GSTIN on purpose',
    });
    expect(bad.headers.location).toBe('/tenants/new');
    expect((await q(`select 1 from tenants where name = 'Client C'`)).length).toBe(0);
  });

  it('records and removes the DLT link with evidence; the PE id is required', async () => {
    const noPe = await post(`/tenants/${T}/dlt`, {
      linked: 'true',
      evidence: 'checked portal 2026-09-13',
    });
    expect(noPe.statusCode).toBe(303);
    expect(
      (
        await q<{ dlt_linked_at: Date | null }>(`select dlt_linked_at from tenants where id = $1`, [
          T,
        ])
      )[0]?.dlt_linked_at,
    ).toBeNull();

    await post(`/tenants/${T}/dlt`, {
      dlt_pe_id: '1234567890123456',
      linked: 'true',
      evidence: 'PE → telemarketer link visible on Vodafone DLT portal, screenshot in drive',
    });
    const [linked] = await q<{ dlt_pe_id: string; dlt_linked_at: Date | null }>(
      `select dlt_pe_id, dlt_linked_at from tenants where id = $1`,
      [T],
    );
    expect(linked).toEqual({ dlt_pe_id: '1234567890123456', dlt_linked_at: NOW });
    expect((await get(`/tenants/${T}`)).body).toContain('Remove DLT link');

    await post(`/tenants/${T}/dlt`, {
      linked: 'false',
      evidence: 'merchant switched telemarketer, link removed',
    });
    expect(
      (
        await q<{ dlt_linked_at: Date | null }>(`select dlt_linked_at from tenants where id = $1`, [
          T,
        ])
      )[0]?.dlt_linked_at,
    ).toBeNull();
    const actions = await q<{ action: string }>(
      `select action from audit_log where tenant_id = $1 and action like 'tenant.dlt%' order by at`,
      [T],
    );
    expect(actions.map((a) => a.action)).toEqual(['tenant.dlt_linked', 'tenant.dlt_unlinked']);
  });
});
