import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withTenant, type Db } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import { newId } from '@naaradh/shared';
import {
  consumeLoginToken,
  getSsoSettings,
  issueLoginLinks,
  issueSignInOptions,
  openSsoSession,
  saveSsoSettings,
  setSsoEnforced,
  setSsoStatus,
  ssoConfigBySlug,
  type Actor,
  type SsoDeps,
} from '../../src/index.js';

/**
 * P7-ENT-1: the database half of single sign-on. The app verifies the ID token; these prove
 * what the database adds on its own — a session only for an enabled user of the tenant, inside
 * its domains, never a new user; enforcement that holds even for links issued before it; and
 * isolation between tenants.
 */

const A = newId('tenant');
const B = newId('tenant');
const NOW = new Date('2026-09-28T06:30:00Z');
const OWNER_A = newId('user');
const STAFF_A = newId('user');
const DISABLED_A = newId('user');
const OUTSIDER_A = newId('user');
const STAFF_B = newId('user');
const KEY = { key: randomBytes(32), kid: 1 };
const ISSUER = 'https://idp.client-a.example';

// A provider that answers discovery; nothing else is fetched when settings are saved.
const idp: SsoDeps = {
  resolve: async () => ['34.117.59.81'],
  fetch: async () =>
    new Response(
      JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/keys`,
      }),
    ),
};

let pg: TestPostgres;
let service: RoleClient;
let app: Db;
let closeApp: () => Promise<void>;
let slug = '';

const owner: Actor = { tenantId: A, type: 'user', id: OWNER_A };
const settings = {
  issuer: ISSUER,
  client_id: 'naaradh',
  client_secret: 'very-secret',
  email_domains: ['client-a.example'],
};
const open = (email: string, tenantId = A) =>
  openSsoSession(app, { tenantId, email, userAgent: 'test', ipHash: null, now: NOW });

beforeAll(async () => {
  pg = await startTestPostgres();
  service = new RoleClient(pg.urls.service);
  for (const [id, name] of [
    [A, 'Client A'],
    [B, 'Client B'],
  ] as const)
    await service.query(
      `insert into tenants (id, name, country, data_region, status) values ($1, $2, 'IN', 'in', 'active')`,
      [id, name],
    );
  await service.query(
    `insert into users (id, tenant_id, email, role, disabled_at) values
       ($1, $6, 'owner@client-a.example', 'owner', null),
       ($2, $6, 'staff@client-a.example', 'operator', null),
       ($3, $6, 'gone@client-a.example', 'viewer', now()),
       ($4, $6, 'contractor@gmail.com', 'viewer', null),
       ($5, $7, 'staff@client-a.example', 'owner', null)`,
    [OWNER_A, STAFF_A, DISABLED_A, OUTSIDER_A, STAFF_B, A, B],
  );
  const a = createDb({ url: pg.urls.app, max: 3 });
  app = a.db;
  closeApp = a.close;
  const view = await withTenant(app, A, (tx) => saveSsoSettings(tx, owner, KEY, settings, idp));
  slug = view.slug;
}, 180_000);

afterAll(async () => {
  await closeApp();
  await service.end();
  await pg.stop();
});

describe('configuration', () => {
  it('starts in testing, not enforced, with a random 16-character link', async () => {
    const v = await withTenant(app, A, (tx) => getSsoSettings(tx, A));
    expect(v).toMatchObject({ status: 'testing', enforced: false, lastSuccessAt: null });
    expect(v?.slug).toMatch(/^[a-z0-9]{16}$/);
  });

  it('keeps the client secret sealed: the row holds ciphertext, the link opens it', async () => {
    const row = await service.query<{ enc: Buffer }>(
      `select client_secret_enc as enc from tenant_sso where tenant_id = $1`,
      [A],
    );
    expect(row.rows[0]?.enc.toString('utf8')).not.toContain('very-secret');
    const cfg = await ssoConfigBySlug(app, slug, KEY);
    expect(cfg).toMatchObject({ tenantId: A, clientSecret: 'very-secret' });
  });

  it('a sealed secret copied onto another tenant does not open (AAD = tenant)', async () => {
    await withTenant(app, B, (tx) =>
      saveSsoSettings(tx, { tenantId: B, type: 'user', id: STAFF_B }, KEY, settings, idp),
    );
    const bSlug =
      (
        await service.query<{ slug: string }>(`select slug from tenant_sso where tenant_id = $1`, [
          B,
        ])
      ).rows[0]?.slug ?? '';
    await service.query(
      `update tenant_sso set client_secret_enc = a.client_secret_enc, client_secret_iv = a.client_secret_iv, client_secret_tag = a.client_secret_tag
         from tenant_sso a where a.tenant_id = $1 and tenant_sso.tenant_id = $2`,
      [A, B],
    );
    await expect(ssoConfigBySlug(app, bSlug, KEY)).rejects.toThrow();
    await withTenant(app, B, (tx) =>
      setSsoStatus(tx, { tenantId: B, type: 'user', id: STAFF_B }, 'disabled'),
    );
  });

  it('an unknown or malformed link finds nothing', async () => {
    expect(await ssoConfigBySlug(app, 'aaaaaaaaaaaaaaaa', KEY)).toBeNull();
    expect(await ssoConfigBySlug(app, "x' or 1=1 --", KEY)).toBeNull();
  });

  it('cannot be required before anyone has signed in through it', async () => {
    await expect(withTenant(app, A, (tx) => setSsoEnforced(tx, owner, true))).rejects.toThrow(
      /sign in once/,
    );
  });

  it('the database refuses enforcement without proof, even past the app', async () => {
    await expect(
      service.query(`update tenant_sso set enforced = true where tenant_id = $1`, [A]),
    ).rejects.toThrow(/tenant_sso_enforced_needs_proof/);
  });

  it('negative: another tenant cannot read it (RLS)', async () => {
    const seen = await withTenant(app, B, (tx) =>
      tx.execute(sql`select count(*)::int as n from tenant_sso where tenant_id = ${A}`),
    );
    expect((seen.rows[0] as { n: number }).n).toBe(0);
  });
});

describe('opening a session', () => {
  it('opens for an enabled user of the tenant, and proves the configuration', async () => {
    const s = await open('staff@client-a.example');
    expect(s).toMatchObject({ tenantId: A, userId: STAFF_A });
    const v = await withTenant(app, A, (tx) => getSsoSettings(tx, A));
    expect(v?.status).toBe('active');
    expect(v?.lastSuccessAt).not.toBeNull();
    const audit = await service.query<{ after: unknown }>(
      `select after from audit_log where tenant_id = $1 and action = 'user.signed_in' and actor_id = $2`,
      [A, STAFF_A],
    );
    expect(audit.rows.at(-1)?.after).toEqual({ method: 'sso' });
  });

  it('never creates a user: an unknown address gets nothing', async () => {
    expect(await open('stranger@client-a.example')).toBeNull();
    const n = await service.query<{ n: number }>(
      `select count(*)::int as n from users where email = 'stranger@client-a.example'`,
    );
    expect(n.rows[0]?.n).toBe(0);
  });

  it('refuses a disabled user', async () => {
    expect(await open('gone@client-a.example')).toBeNull();
  });

  it("refuses an invited user outside the provider's domains", async () => {
    expect(await open('contractor@gmail.com')).toBeNull();
  });

  it("does not open another tenant's account for the same address", async () => {
    // staff@client-a.example is also B's owner; A's provider must never reach B.
    const s = await open('staff@client-a.example', A);
    expect(s?.tenantId).toBe(A);
    expect(await open('staff@client-a.example', B)).toBeNull(); // B's SSO is disabled
  });
});

describe('requiring single sign-on', () => {
  let earlyToken = '';

  it('a link issued before enforcement is dead once it is on (non-owner)', async () => {
    const [link] = await issueLoginLinks(app, {
      email: 'staff@client-a.example',
      ipHash: null,
      now: NOW,
    });
    earlyToken = link?.token ?? '';
    expect(earlyToken).not.toBe('');
    await withTenant(app, A, (tx) => setSsoEnforced(tx, owner, true));
    expect(
      await consumeLoginToken(app, { token: earlyToken, userAgent: null, ipHash: null, now: NOW }),
    ).toBeNull();
  });

  it('non-owners in the domains get a pointer to SSO, not a link', async () => {
    const r = await issueSignInOptions(app, {
      email: 'staff@client-a.example',
      ipHash: null,
      now: NOW,
    });
    expect(r.links.map((l) => l.tenantId)).not.toContain(A);
    expect(r.sso).toEqual([expect.objectContaining({ tenantId: A, slug })]);
    // The same address at tenant B (SSO off there) still gets its email link.
    expect(r.links.map((l) => l.tenantId)).toContain(B);
  });

  it('owners keep the email link as the way back in', async () => {
    const r = await issueSignInOptions(app, {
      email: 'owner@client-a.example',
      ipHash: null,
      now: NOW,
    });
    expect(r.sso).toEqual([]);
    const [link] = r.links;
    expect(
      await consumeLoginToken(app, {
        token: link?.token ?? '',
        userAgent: null,
        ipHash: null,
        now: NOW,
      }),
    ).not.toBeNull();
  });

  it('users outside the domains are not affected', async () => {
    const r = await issueSignInOptions(app, {
      email: 'contractor@gmail.com',
      ipHash: null,
      now: NOW,
    });
    expect(r.sso).toEqual([]);
    expect(r.links).toHaveLength(1);
  });

  it('changing the provider sends it back to testing and lifts enforcement', async () => {
    const v = await withTenant(app, A, (tx) =>
      saveSsoSettings(tx, owner, KEY, { ...settings, client_id: 'naaradh-2' }, idp),
    );
    expect(v).toMatchObject({ status: 'testing', enforced: false, lastSuccessAt: null });
    const r = await issueSignInOptions(app, {
      email: 'staff@client-a.example',
      ipHash: null,
      now: NOW,
    });
    expect(r.sso).toEqual([]);
  });

  it('turned off, the link finds nothing and no session opens', async () => {
    await withTenant(app, A, (tx) => setSsoStatus(tx, owner, 'disabled'));
    expect(await ssoConfigBySlug(app, slug, KEY)).toBeNull();
    expect(await open('staff@client-a.example')).toBeNull();
  });

  it('every change is audited', async () => {
    const r = await service.query<{ action: string }>(
      `select action from audit_log where tenant_id = $1 and action like 'sso.%' order by at, id`,
      [A],
    );
    expect(r.rows.map((x) => x.action)).toEqual(
      expect.arrayContaining(['sso.configured', 'sso.enforced', 'sso.changed', 'sso.disabled']),
    );
  });
});
