import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withTenant, type Db } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import { ABANDONED_CART_HI_IN, COD_CONFIRM_EN_IN } from '@naaradh/call-scripts';
import { addMinutes, generatePhoneKeyPair, newId, parseSecretKey } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { createIntent } from '../../src/intents.js';
import type { PhoneKeys } from '../../src/contacts.js';
import {
  addSuppression,
  accessMedia,
  approveScript,
  changeRole,
  consumeLoginToken,
  createApiKey,
  createArticle,
  deleteShopifySessions,
  loadShopifySession,
  provisionShopifyInstall,
  shopifySessionsForShop,
  storeShopifySession,
  disableUser,
  getSettings,
  inviteUser,
  issueLoginLinks,
  liftSuppression,
  listActivity,
  listOutbound,
  listScripts,
  outboundDetail,
  overview,
  resolveWebSession,
  revokeApiKey,
  revokeSessions,
  setUseCaseEnabled,
  updateSettings,
  abTestMetrics,
  endAbTest,
  isAbTestRunning,
  recoveryReport,
  startAbTest,
  SettingsInput as SettingsSchema,
  type Actor,
  type SettingsInput,
} from '../../src/index.js';

const A = newId('tenant');
const B = newId('tenant');
const NOW = new Date('2026-09-14T06:30:00Z');
const OWNER_A = newId('user');
const MANAGER_A = newId('user');
const VIEWER_A = newId('user');
const OWNER_B = newId('user');
const SHARED_EMAIL = 'ops@client-a.example';
const keys: PhoneKeys = {
  hashKey: 'h'.repeat(32),
  encPublicKeyPem: generatePhoneKeyPair().publicKeyPem,
  encKid: 1,
};

let pg: TestPostgres;
let service: RoleClient;
let appRaw: RoleClient;
let app: Db;
let closeApp: () => Promise<void>;
let codUseCase: string;
let promoUseCase: string;

const actor = (tenantId: string, id: string): Actor => ({ tenantId, type: 'user', id });

beforeAll(async () => {
  pg = await startTestPostgres();
  service = new RoleClient(pg.urls.service);
  appRaw = new RoleClient(pg.urls.app);
  for (const [id, name] of [
    [A, 'Client A'],
    [B, 'Client B'],
  ] as const)
    await service.query(
      `insert into tenants (id, name, country, data_region, status) values ($1, $2, 'IN', 'in', 'active')`,
      [id, name],
    );
  codUseCase = newId('useCase');
  promoUseCase = newId('useCase');
  await service.query(
    `insert into use_cases (id, tenant_id, kind, purpose, enabled, config) values ($1, $2, 'cod_confirm', 'transactional', true, '{"pilotPercent":100}'), ($3, $2, 'abandoned_cart', 'promotional', false, '{}')`,
    [codUseCase, A, promoUseCase],
  );
  await service.query(
    `insert into users (id, tenant_id, email, role) values ($1, $5, 'owner@client-a.example', 'owner'), ($2, $5, $7, 'manager'), ($3, $5, 'viewer@client-a.example', 'viewer'), ($4, $6, $7, 'owner')`,
    [OWNER_A, MANAGER_A, VIEWER_A, OWNER_B, A, B, SHARED_EMAIL],
  );
  const a = createDb({ url: pg.urls.app, max: 3 });
  app = a.db;
  closeApp = a.close;
}, 180_000);

afterAll(async () => {
  await closeApp();
  await service.end();
  await appRaw.end();
  await pg.stop();
});

describe('dashboard sign-in (ADR-0009)', () => {
  it('a stranger gets no link; an email on two accounts gets one link per account', async () => {
    expect(
      await issueLoginLinks(app, { email: 'nobody@example.com', ipHash: null, now: NOW }),
    ).toEqual([]);
    expect(await issueLoginLinks(app, { email: 'not-an-email', ipHash: null, now: NOW })).toEqual(
      [],
    );
    const links = await issueLoginLinks(app, {
      email: ' OPS@client-a.example ',
      ipHash: 'ip',
      now: NOW,
    });
    expect(links.map((l) => l.tenantName).sort()).toEqual(['Client A', 'Client B']);
    const stored = await service.query<{ token_hash: string }>(
      `select token_hash from login_tokens`,
    );
    // Only the hash is stored.
    for (const l of links) expect(stored.rows.map((r) => r.token_hash)).not.toContain(l.token);
  });

  it('a login token opens exactly one session, only within 15 minutes', async () => {
    const [link] = await issueLoginLinks(app, {
      email: 'owner@client-a.example',
      ipHash: null,
      now: NOW,
    });
    if (link === undefined) throw new Error('no link');
    const later = addMinutes(NOW, 16);
    expect(
      await consumeLoginToken(app, {
        token: link.token,
        userAgent: 'test',
        ipHash: null,
        now: later,
      }),
    ).toBeNull();
    const [fresh] = await issueLoginLinks(app, {
      email: 'owner@client-a.example',
      ipHash: null,
      now: NOW,
    });
    if (fresh === undefined) throw new Error('no link');
    const [first, second] = await Promise.all([
      consumeLoginToken(app, {
        token: fresh.token,
        userAgent: 'a',
        ipHash: null,
        now: addMinutes(NOW, 1),
      }),
      consumeLoginToken(app, {
        token: fresh.token,
        userAgent: 'b',
        ipHash: null,
        now: addMinutes(NOW, 1),
      }),
    ]);
    const opened = [first, second].filter((s) => s !== null);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.tenantId).toBe(A);
    const audit = await service.query(
      `select 1 from audit_log where action = 'user.signed_in' and actor_id = $1`,
      [OWNER_A],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('a session resolves until revoked, idle, expired or the user is disabled', async () => {
    const open = async (email: string) => {
      const [l] = await issueLoginLinks(app, { email, ipHash: null, now: NOW });
      if (l === undefined) throw new Error('no link');
      const s = await consumeLoginToken(app, {
        token: l.token,
        userAgent: null,
        ipHash: null,
        now: NOW,
      });
      if (s === null) throw new Error('no session');
      return s;
    };
    const s = await open('viewer@client-a.example');
    const r = await resolveWebSession(app, s.sessionToken, addMinutes(NOW, 60));
    expect(r).toMatchObject({
      tenantId: A,
      userId: VIEWER_A,
      role: 'viewer',
      tenantName: 'Client A',
    });
    expect(await resolveWebSession(app, 'x'.repeat(43), NOW)).toBeNull();
    expect(await resolveWebSession(app, undefined, NOW)).toBeNull();
    // Idle for 13 hours after the last touch.
    expect(await resolveWebSession(app, s.sessionToken, addMinutes(NOW, 60 + 13 * 60))).toBeNull();

    const s2 = await open('viewer@client-a.example');
    await withTenant(app, A, (tx) =>
      revokeSessions(tx, actor(A, VIEWER_A), { sessionId: s2.sessionId }, NOW),
    );
    expect(await resolveWebSession(app, s2.sessionToken, NOW)).toBeNull();

    const s3 = await open('viewer@client-a.example');
    await withTenant(app, A, (tx) =>
      disableUser(tx, actor(A, MANAGER_A), 'manager', VIEWER_A, NOW),
    );
    expect(await resolveWebSession(app, s3.sessionToken, NOW)).toBeNull();
    expect(
      await issueLoginLinks(app, { email: 'viewer@client-a.example', ipHash: null, now: NOW }),
    ).toEqual([]);
  });

  it('at most 5 live tokens per user', async () => {
    const t = addMinutes(NOW, 100);
    const counts: number[] = [];
    for (let i = 0; i < 7; i++)
      counts.push(
        (await issueLoginLinks(app, { email: 'owner@client-a.example', ipHash: null, now: t }))
          .length,
      );
    expect(counts.filter((c) => c === 1).length).toBeLessThanOrEqual(5);
    expect(counts.at(-1)).toBe(0);
  });

  it('the app role cannot read tokens or Shopify sessions directly', async () => {
    const priv = await service.query<Record<string, boolean>>(
      `select has_table_privilege('naaradh_app','login_tokens','SELECT') as tokens,
              has_table_privilege('naaradh_app','shopify_sessions','SELECT') as shopify,
              has_table_privilege('naaradh_app','web_sessions','UPDATE') as sessions_update,
              has_column_privilege('naaradh_app','web_sessions','revoked_at','UPDATE') as revoke`,
    );
    expect(priv.rows[0]).toEqual({
      tokens: false,
      shopify: false,
      sessions_update: false,
      revoke: true,
    });
    await expect(appRaw.inTenant(A, (c) => c.query('select * from login_tokens'))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      appRaw.inTenant(A, (c) =>
        c.query(`update web_sessions set expires_at = now() + interval '1 year'`),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('Shopify sessions and install provisioning (ADR-0007/0009)', () => {
  const shop = 'client-c-dev.myshopify.com';
  const key = parseSecretKey(randomBytes(32).toString('base64'));
  const keyring = new Map([[1, key]]);

  it('stores only ciphertext; the definer functions round-trip it for the app role', async () => {
    const id = `offline_${shop}`;
    await storeShopifySession(
      app,
      { key, kid: 1 },
      {
        id,
        shop,
        state: '',
        isOnline: false,
        scope: 'read_orders,write_orders',
        expires: null,
        accessToken: 'shpat_fake',
        refreshToken: null,
        refreshTokenExpires: null,
      },
    );
    const raw = await service.query<{ secret_ciphertext: Buffer }>(
      `select secret_ciphertext from shopify_sessions where id = $1`,
      [id],
    );
    expect(raw.rows[0]?.secret_ciphertext.toString('utf8')).not.toContain('shpat');
    expect((await loadShopifySession(app, keyring, id))?.accessToken).toBe('shpat_fake');
    expect((await shopifySessionsForShop(app, keyring, shop)).map((s) => s.id)).toEqual([id]);
    // Wrong key → treated as no session (the app re-authenticates), never garbage.
    expect(await loadShopifySession(app, new Map([[1, randomBytes(32)]]), id)).toBeNull();
    // A sealed token moved to another row does not open there.
    await service.query(
      `insert into shopify_sessions (id, shop, secret_ciphertext, secret_iv, secret_tag)
       select 'offline_other-dev.myshopify.com', 'other-dev.myshopify.com', secret_ciphertext, secret_iv, secret_tag from shopify_sessions where id = $1`,
      [id],
    );
    expect(await loadShopifySession(app, keyring, 'offline_other-dev.myshopify.com')).toBeNull();
    expect(await deleteShopifySessions(app, ['offline_other-dev.myshopify.com'])).toBe(1);
    await expect(
      storeShopifySession(
        app,
        { key, kid: 1 },
        {
          id: 'x',
          shop: 'not a shop',
          state: '',
          isOnline: false,
          scope: null,
          expires: null,
          accessToken: 't',
          refreshToken: null,
          refreshTokenExpires: null,
        },
      ),
    ).rejects.toThrow();
  });

  const provision = () =>
    provisionShopifyInstall(app, {
      shop,
      name: 'Client C',
      country: 'IN',
      dataRegion: 'in',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      ownerEmail: 'owner@client-c.example',
      scopes: ['read_orders', 'write_orders'],
      apiVersion: '2026-07',
      now: NOW,
    });

  it('first install creates tenant (pending review), integration and owner; concurrent loads create one', async () => {
    const rows = await Promise.all([provision(), provision()]);
    expect(rows.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(rows.map((r) => r.tenantId)).size).toBe(1);
    const tenantId = rows[0].tenantId;
    const t = await service.query<{ status: string }>(`select status from tenants where id = $1`, [
      tenantId,
    ]);
    expect(t.rows[0]?.status).toBe('pending_review');
    const i = await service.query<{ credentials_secret_ref: string; scopes: string[] }>(
      `select credentials_secret_ref, scopes from integrations where tenant_id = $1`,
      [tenantId],
    );
    expect(i.rows[0]).toEqual({
      credentials_secret_ref: `shopify-session:offline_${shop}`,
      scopes: ['read_orders', 'write_orders'],
    });
    const u = await service.query<{ role: string }>(`select role from users where tenant_id = $1`, [
      tenantId,
    ]);
    expect(u.rows).toEqual([{ role: 'owner' }]);
  });

  it('reinstall lifts only the uninstall pause', async () => {
    const [existing] = (
      await service.query<{ tenant_id: string }>(
        `select tenant_id from integrations where external_id = $1`,
        [shop],
      )
    ).rows;
    const tenantId = existing?.tenant_id ?? '';
    await service.query(
      `update integrations set status = 'uninstalled', uninstalled_at = now() where external_id = $1`,
      [shop],
    );
    // Review ended a day before the test clock (not the database clock: they differ by days).
    await service.query(
      `update tenants set status = 'paused', paused_reason = 'app/uninstalled', review_until = $2 where id = $1`,
      [tenantId, addMinutes(NOW, -24 * 60)],
    );
    expect(await provision()).toEqual({ tenantId, created: false, reinstalled: true });
    const t = await service.query<{ status: string; paused_reason: string | null }>(
      `select status, paused_reason from tenants where id = $1`,
      [tenantId],
    );
    expect(t.rows[0]).toEqual({ status: 'active', paused_reason: null });

    // A complaint pause is not the app's to lift.
    await service.query(`update integrations set status = 'uninstalled' where external_id = $1`, [
      shop,
    ]);
    await service.query(
      `update tenants set status = 'paused', paused_reason = 'complaints:3_in_10d' where id = $1`,
      [tenantId],
    );
    await provision();
    const t2 = await service.query<{ status: string }>(`select status from tenants where id = $1`, [
      tenantId,
    ]);
    expect(t2.rows[0]?.status).toBe('paused');
  });
});

describe('team rules', () => {
  it('managers cannot create owners; the last owner cannot be demoted or disabled', async () => {
    await expect(
      withTenant(app, A, (tx) =>
        inviteUser(tx, actor(A, MANAGER_A), 'manager', {
          email: 'new@client-a.example',
          name: null,
          role: 'owner',
        }),
      ),
    ).rejects.toThrow(/owner role/);
    const invited = await withTenant(app, A, (tx) =>
      inviteUser(tx, actor(A, MANAGER_A), 'manager', {
        email: 'new@client-a.example',
        name: 'New',
        role: 'operator',
      }),
    );
    expect(invited.created).toBe(true);
    await expect(
      withTenant(app, A, (tx) => changeRole(tx, actor(A, OWNER_A), 'owner', OWNER_A, 'manager')),
    ).rejects.toThrow(/at least one owner/);
    await expect(
      withTenant(app, A, (tx) => disableUser(tx, actor(A, OWNER_A), 'owner', OWNER_A, NOW)),
    ).rejects.toThrow(/at least one owner/);
    // RLS: a user id from another tenant is simply not found.
    await expect(
      withTenant(app, A, (tx) => changeRole(tx, actor(A, OWNER_A), 'owner', OWNER_B, 'viewer')),
    ).rejects.toThrow(/not found/);
  });
});

describe('settings, use cases, scripts', () => {
  const base = (s: Awaited<ReturnType<typeof getSettings>>): SettingsInput => ({
    name: s.name,
    legal_name: s.legal_name,
    timezone: s.timezone,
    gstin: s.gstin,
    pan: s.pan,
    dlt_pe_id: s.dlt_pe_id,
    spend_cap_daily_paise: s.spend_cap_daily_paise,
    spend_cap_monthly_paise: s.spend_cap_monthly_paise,
    retention_days: s.retention_days,
    amd_mode_transactional: s.amd_mode_transactional,
    amd_mode_promotional: s.amd_mode_promotional,
    auto_cancel_enabled: s.auto_cancel_enabled,
    shopify_sync_optout: s.shopify_sync_optout,
    notifications: s.notifications,
  });

  it('viewers cannot change settings; a manager change is audited field by field', async () => {
    const s = await withTenant(app, A, (tx) => getSettings(tx, A));
    await expect(
      withTenant(app, A, (tx) => updateSettings(tx, actor(A, VIEWER_A), 'viewer', base(s))),
    ).rejects.toThrow(/manager role/);
    const next = await withTenant(app, A, (tx) =>
      updateSettings(tx, actor(A, MANAGER_A), 'manager', {
        ...base(s),
        retention_days: 60,
        notifications: { daily_summary: false, gated_digest: true },
      }),
    );
    expect(next.retention_days).toBe(60);
    expect(next.notifications.daily_summary).toBe(false);
    const a = await service.query<{ after: Record<string, unknown> }>(
      `select after from audit_log where action = 'tenant.settings_updated' and tenant_id = $1`,
      [A],
    );
    expect(Object.keys(a.rows[0]?.after ?? {}).sort()).toEqual(['notifications', 'retention_days']);
  });

  it('promotional use cases need a DLT PE id before they can be enabled', async () => {
    await expect(
      withTenant(app, A, (tx) =>
        setUseCaseEnabled(tx, actor(A, MANAGER_A), 'manager', promoUseCase, true),
      ),
    ).rejects.toThrow(/DLT/);
    const off = await withTenant(app, A, (tx) =>
      setUseCaseEnabled(tx, actor(A, MANAGER_A), 'manager', codUseCase, false),
    );
    expect(off.enabled).toBe(false);
  });

  it('approving a script re-validates the disclosure and retires the previous approved version', async () => {
    const v1 = newId('script');
    const v2 = newId('script');
    const bad = newId('script');
    await service.query(
      `insert into scripts (id, tenant_id, use_case_id, version, locale, body, status) values
        ($1, $4, $5, 1, 'en-IN', $6, 'draft'), ($2, $4, $5, 2, 'en-IN', $6, 'draft'), ($3, $4, $5, 3, 'en-IN', $7, 'draft')`,
      [
        v1,
        v2,
        bad,
        A,
        codUseCase,
        JSON.stringify(COD_CONFIRM_EN_IN),
        JSON.stringify({
          ...COD_CONFIRM_EN_IN,
          opening: 'Hello {{customer_name}}, calling about your order.',
        }),
      ],
    );
    await withTenant(app, A, (tx) => approveScript(tx, actor(A, MANAGER_A), 'manager', v1, NOW));
    await withTenant(app, A, (tx) => approveScript(tx, actor(A, MANAGER_A), 'manager', v2, NOW));
    const rows = await service.query<{ id: string; status: string }>(
      `select id, status from scripts where id = any($1) order by version`,
      [[v1, v2]],
    );
    expect(rows.rows.map((r) => r.status)).toEqual(['retired', 'approved']);
    await expect(
      withTenant(app, A, (tx) => approveScript(tx, actor(A, MANAGER_A), 'manager', bad, NOW)),
    ).rejects.toThrow(/validation/);
    const listed = await withTenant(app, A, (tx) => listScripts(tx, A));
    expect(listed.find((s) => s.id === bad)?.problems).toBeTruthy();
  });
});

describe('promotional scripts, A/B tests and results settings (ADR-0010)', () => {
  const draft = async (version: number) => {
    const id = newId('script');
    await service.query(
      `insert into scripts (id, tenant_id, use_case_id, version, locale, body, status) values ($1, $2, $3, $4, 'hi-IN', $5, 'draft')`,
      [id, A, promoUseCase, version, JSON.stringify(ABANDONED_CART_HI_IN)],
    );
    return id;
  };
  const m = actor(A, MANAGER_A);
  let v1: string;
  let v2: string;

  it('a promotional use case cannot be switched on until an approved script carries a DLT template', async () => {
    const s = await withTenant(app, A, (tx) => getSettings(tx, A));
    await withTenant(app, A, (tx) =>
      updateSettings(tx, m, 'manager', {
        ...SettingsSchema.parse({ ...s }),
        dlt_pe_id: '1101234567890123',
      }),
    );
    await expect(
      withTenant(app, A, (tx) => setUseCaseEnabled(tx, m, 'manager', promoUseCase, true)),
    ).rejects.toThrow(/DLT content template/);
  });

  it('E-112: approval needs the template id, in DLT format, and freezes it with the script', async () => {
    v1 = await draft(1);
    await expect(
      withTenant(app, A, (tx) => approveScript(tx, m, 'manager', v1, NOW)),
    ).rejects.toThrow(/DLT content template/);
    await expect(
      withTenant(app, A, (tx) =>
        approveScript(tx, m, 'manager', v1, NOW, { dltTemplateId: 'TEMPLATE-1' }),
      ),
    ).rejects.toThrow(/DLT content template/);
    await withTenant(app, A, (tx) =>
      approveScript(tx, m, 'manager', v1, NOW, { dltTemplateId: ' 1107160000000000201 ' }),
    );
    const listed = await withTenant(app, A, (tx) => listScripts(tx, A));
    expect(listed.find((x) => x.id === v1)).toMatchObject({
      status: 'approved',
      dltTemplateId: '1107160000000000201',
      promotional: true,
    });
    // Frozen: the approved version's template id cannot be edited afterwards.
    await expect(
      withTenant(app, A, (tx) =>
        tx.execute(
          sql`update scripts set dlt_template_id = '1107169999999999999' where id = ${v1}`,
        ),
      ),
    ).rejects.toThrow();
    const on = await withTenant(app, A, (tx) =>
      setUseCaseEnabled(tx, m, 'manager', promoUseCase, true),
    );
    expect(on.enabled).toBe(true);
  });

  it('an A/B test needs its own template for the challenger and blocks other approvals while it runs (E-116)', async () => {
    v2 = await draft(2);
    await expect(
      withTenant(app, A, (tx) => startAbTest(tx, m, 'manager', v2, NOW)),
    ).rejects.toThrow(/template/);
    await expect(
      withTenant(app, A, (tx) =>
        startAbTest(tx, actor(A, VIEWER_A), 'viewer', v2, NOW, {
          dltTemplateId: '1107160000000000202',
        }),
      ),
    ).rejects.toThrow(/manager role/);
    await withTenant(app, A, (tx) =>
      startAbTest(tx, m, 'manager', v2, NOW, { dltTemplateId: '1107160000000000202' }),
    );
    const arms = await service.query<{ id: string; ab_arm: string | null; status: string }>(
      `select id, ab_arm, status from scripts where id = any($1) order by version`,
      [[v1, v2]],
    );
    expect(arms.rows.map((r) => [r.ab_arm, r.status])).toEqual([
      ['A', 'approved'],
      ['B', 'approved'],
    ]);
    expect(await withTenant(app, A, (tx) => isAbTestRunning(tx, A, promoUseCase, 'hi-IN'))).toBe(
      true,
    );

    const v3 = await draft(3);
    await expect(
      withTenant(app, A, (tx) =>
        approveScript(tx, m, 'manager', v3, NOW, { dltTemplateId: '1107160000000000203' }),
      ),
    ).rejects.toThrow(/A\/B test is running/);
    await expect(
      withTenant(app, A, (tx) =>
        startAbTest(tx, m, 'manager', v3, NOW, { dltTemplateId: '1107160000000000203' }),
      ),
    ).rejects.toThrow(/already running/);
    // The database refuses a third live version for the same arm, whatever the code does.
    await expect(
      service.query(
        `insert into scripts (id, tenant_id, use_case_id, version, locale, body, status, ab_arm, approved_at, disclosure_validated_at, dlt_template_id) values ($1, $2, $3, 9, 'hi-IN', $4, 'approved', 'B', now(), now(), '1107160000000000209')`,
        [newId('script'), A, promoUseCase, JSON.stringify(ABANDONED_CART_HI_IN)],
      ),
    ).rejects.toThrow(/scripts_one_approved_per_arm/);

    const [test] = await withTenant(app, A, (tx) => abTestMetrics(tx, A));
    expect(test).toMatchObject({
      useCase: 'abandoned_cart',
      locale: 'hi-IN',
      pValue: null,
      leader: null,
    });
    expect(test?.arms.map((a) => [a.arm, a.dialled, a.answered])).toEqual([
      ['A', 0, 0],
      ['B', 0, 0],
    ]);
  });

  it('ending the test keeps one version and retires the other', async () => {
    await expect(
      withTenant(app, A, (tx) => endAbTest(tx, m, 'manager', newId('script'), NOW)),
    ).rejects.toThrow(/not found/);
    const r = await withTenant(app, A, (tx) => endAbTest(tx, m, 'manager', v2, NOW));
    expect(r.retiredId).toBe(v1);
    const rows = await service.query<{ id: string; ab_arm: string | null; status: string }>(
      `select id, ab_arm, status from scripts where id = any($1) order by version`,
      [[v1, v2]],
    );
    expect(rows.rows.map((x) => [x.status, x.ab_arm])).toEqual([
      ['retired', null],
      ['approved', null],
    ]);
    expect(await withTenant(app, A, (tx) => isAbTestRunning(tx, A, promoUseCase, 'hi-IN'))).toBe(
      false,
    );
    expect(await withTenant(app, A, (tx) => abTestMetrics(tx, A))).toEqual([]);
  });

  it('results settings are optional, bounded, and an older form leaves them alone', async () => {
    const s = await withTenant(app, A, (tx) => getSettings(tx, A));
    expect(s).toMatchObject({ rto_cost_paise: null, attribution_hours: 24 });
    expect(() => SettingsSchema.parse({ ...s, attribution_hours: 0 })).toThrow();
    expect(() => SettingsSchema.parse({ ...s, attribution_hours: 73 })).toThrow();
    const input = SettingsSchema.parse({ ...s, rto_cost_paise: 15000, attribution_hours: 48 });
    await withTenant(app, A, (tx) => updateSettings(tx, m, 'manager', input));
    const { rto_cost_paise: _r, attribution_hours: _h, ...older } = input;
    const after = await withTenant(app, A, (tx) => updateSettings(tx, m, 'manager', older));
    expect(after).toMatchObject({ rto_cost_paise: 15000, attribution_hours: 48 });
    const report = await withTenant(app, A, (tx) =>
      recoveryReport(tx, A, addMinutes(NOW, -7 * 24 * 60), addMinutes(NOW, 60)),
    );
    expect(report.recovered).toMatchObject({ orders: 0, windowHours: 48, revenue: [] });
    expect(report.cod).toMatchObject({ rtoCostPaise: 15000 });
    expect(report.checkouts.total).toBe(0);
  });
});

describe('suppressions and API keys', () => {
  it('a hand-added suppression can be lifted; a customer opt-out cannot', async () => {
    const manual = await withTenant(app, A, (tx) =>
      addSuppression(
        tx,
        actor(A, MANAGER_A),
        'manager',
        keys.hashKey,
        { phone: FAKE_IN.customerAlt, region: 'IN', purpose: 'all', reason: 'manual' },
        NOW,
      ),
    );
    await withTenant(app, A, (tx) =>
      liftSuppression(
        tx,
        actor(A, MANAGER_A),
        'manager',
        manual.id,
        'added by mistake for a test',
        NOW,
      ),
    );
    const optOut = await withTenant(app, A, (tx) =>
      addSuppression(
        tx,
        actor(A, MANAGER_A),
        'manager',
        keys.hashKey,
        { phone: FAKE_IN.optedOut, region: 'IN', purpose: 'all', reason: 'opt_out' },
        NOW,
      ),
    );
    await expect(
      withTenant(app, A, (tx) =>
        liftSuppression(
          tx,
          actor(A, OWNER_A),
          'owner',
          optOut.id,
          'customer changed their mind',
          NOW,
        ),
      ),
    ).rejects.toThrow(/cannot/);
  });

  it('only owners create keys; public keys are intents-only with a domain; revoked keys stop resolving', async () => {
    await expect(
      withTenant(app, A, (tx) =>
        createApiKey(tx, actor(A, MANAGER_A), 'manager', {
          name: 'x',
          kind: 'secret',
          env: 'live',
          scopes: ['intents:create'],
          allowed_domains: [],
          daily_cap: null,
        }),
      ),
    ).rejects.toThrow(/owner role/);
    await expect(
      withTenant(app, A, (tx) =>
        createApiKey(tx, actor(A, OWNER_A), 'owner', {
          name: 'site',
          kind: 'public',
          env: 'live',
          scopes: ['intents:create'],
          allowed_domains: [],
          daily_cap: null,
        }),
      ),
    ).rejects.toThrow(/domain/);
    const k = await withTenant(app, A, (tx) =>
      createApiKey(tx, actor(A, OWNER_A), 'owner', {
        name: 'backend',
        kind: 'secret',
        env: 'live',
        scopes: ['intents:create', 'intents:read'],
        allowed_domains: [],
        daily_cap: 500,
      }),
    );
    expect(k.key).toMatch(/^nrd_live_[A-Za-z0-9]{32}$/);
    const { hashApiKey } = await import('@naaradh/shared');
    const resolved = await appRaw.query<{ tenant_id: string; revoked_at: Date | null }>(
      'select tenant_id, revoked_at from resolve_tenant_by_api_key($1)',
      [hashApiKey(k.key)],
    );
    expect(resolved.rows[0]).toEqual({ tenant_id: A, revoked_at: null });
    await withTenant(app, A, (tx) =>
      revokeApiKey(tx, actor(A, OWNER_A), 'owner', k.id, 'rotated', NOW),
    );
    const after = await appRaw.query<{ revoked_at: Date | null }>(
      'select revoked_at from resolve_tenant_by_api_key($1)',
      [hashApiKey(k.key)],
    );
    expect(after.rows[0]?.revoked_at).not.toBeNull();
  });
});

describe('calls views and audited media access', () => {
  it('lists an order call with its status explained, shows detail, and audits a recording access', async () => {
    const r = await withTenant(app, A, async (tx) => {
      await tx.execute(sql`update use_cases set enabled = true where id = ${codUseCase}`);
      return createIntent(tx, keys, {
        tenantId: A,
        useCase: 'cod_confirm',
        source: 'shopify',
        account: 'client-a.myshopify.com',
        externalRef: 'order-dash-1',
        eventTs: addMinutes(NOW, -1),
        rawPhone: FAKE_IN.customer,
        defaultRegion: 'IN',
        customerName: 'Asha',
        variables: {
          customer_name: 'Asha',
          brand: 'Client A',
          order_ref: 'order-dash-1',
          amount: 499,
        },
        valuePaise: 49_900,
        currency: 'INR',
        now: NOW,
        actor: { type: 'worker', id: 'test' },
      });
    });
    if (r.status !== 'scheduled') throw new Error(`intent not scheduled: ${r.status}`);
    const page = await withTenant(app, A, (tx) => listOutbound(tx, A, { filter: 'active' }));
    const row = page.rows.find((x) => x.id === r.intentId);
    expect(row).toMatchObject({ orderRef: 'order-dash-1', phone: '+91 60xxx xx001' });
    expect(row?.status.label).toBe('Scheduled');
    expect(await withTenant(app, B, (tx) => listOutbound(tx, B))).toEqual({ rows: [], next: null });

    const attemptId = newId('attempt');
    await service.query(
      `insert into call_attempts (id, tenant_id, intent_id, contact_id, phone_hash, direction, purpose, external_ref, attempt_no, engine, from_e164, amd_mode, max_duration_sec, idempotency_key, status, recording_uri)
       select $1, tenant_id, id, contact_id, phone_hash, 'outbound', purpose, external_ref, 1, 'simulator', '+916000000100', 'continue', 120, $1, 'ENDED', 'gs://bucket/rec.mp3' from call_intents where id = $2`,
      [attemptId, r.intentId],
    );
    const detail = await withTenant(app, A, (tx) => outboundDetail(tx, A, r.intentId));
    expect(detail.attempts[0]).toMatchObject({
      id: attemptId,
      hasRecording: true,
      hasTranscript: false,
    });
    expect(detail.customerName).toBe('Asha');
    await expect(withTenant(app, B, (tx) => outboundDetail(tx, B, r.intentId))).rejects.toThrow(
      /not found/,
    );

    const uri = await withTenant(app, A, (tx) =>
      accessMedia(tx, actor(A, MANAGER_A), attemptId, 'recording'),
    );
    expect(uri).toBe('gs://bucket/rec.mp3');
    await expect(
      withTenant(app, A, (tx) => accessMedia(tx, actor(A, MANAGER_A), attemptId, 'transcript')),
    ).rejects.toThrow(/no transcript/);
    const log = await withTenant(app, A, (tx) => listActivity(tx, A, { accessOnly: true }));
    expect(log.find((l) => l.action === 'recording.accessed')).toMatchObject({
      actor: SHARED_EMAIL,
      targetId: attemptId,
    });

    const ov = await withTenant(app, A, (tx) => overview(tx, A, NOW));
    expect(ov.outbound.orders).toBeGreaterThanOrEqual(1);
  });

  it('support admin writes are attributed to the dashboard user', async () => {
    const art = await withTenant(app, A, (tx) =>
      createArticle(tx, actor(A, MANAGER_A), {
        title: 'Returns',
        body: 'Returns within 7 days.',
        locale: 'en-IN',
        tags: [],
        status: 'published',
      }),
    );
    const row = await service.query<{ actor_type: string; actor_id: string }>(
      `select actor_type, actor_id from audit_log where target_id = $1`,
      [art.id],
    );
    expect(row.rows[0]).toEqual({ actor_type: 'user', actor_id: MANAGER_A });
    const created = await service.query<{ created_by: string }>(
      `select created_by from knowledge_articles where id = $1`,
      [art.id],
    );
    expect(created.rows[0]?.created_by).toBe(`user:${MANAGER_A}`);
  });
});
