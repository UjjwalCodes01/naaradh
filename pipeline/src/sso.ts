import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db, type Tx } from '@naaradh/db';
import {
  NaaradhError,
  assertPublicHttpsUrl,
  dnsResolver,
  newId,
  openSealed,
  seal,
  sha256Hex,
  type Resolver,
} from '@naaradh/shared';
import { audit } from './audit.js';
import { auditActor, type Actor } from './admin/actor.js';
import { SESSION_ABSOLUTE_DAYS, type OpenedSession } from './web-auth.js';

/**
 * P7-ENT-1: dashboard single sign-on over OpenID Connect (authorization code + PKCE).
 *
 * What makes it safe, each pinned by a test (pipeline/test/sso.*):
 *   - the provider is found by a per-tenant link, never by the email domain someone typed;
 *   - discovery must name exactly the configured issuer, and every URL we fetch passes the
 *     egress guard (no private addresses, no redirects, bounded size);
 *   - PKCE (S256), `state` bound to a cookie, `nonce` bound to the ID token;
 *   - the ID token is verified here, not trusted: RS256/ES256 only, with the key type checked
 *     against the algorithm, `iss`, `aud`/`azp`, `exp`, `iat`, `nonce`;
 *   - the email is trusted only when the provider vouches for it (`email_verified`, or Entra's
 *     `xms_edov`) — Entra's plain `email` claim can be set by the user ("nOAuth") — and only
 *     inside the tenant's own domains;
 *   - SSO never creates a user, and the database re-checks all of it (open_sso_session).
 */

export const SSO_SLUG = /^[a-z0-9]{16}$/;
export const SSO_STATE_TTL_SEC = 600;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_DOC_BYTES = 256 * 1024;
const CLOCK_SKEW_SEC = 60;
const ALGS = ['RS256', 'ES256'] as const;
type Alg = (typeof ALGS)[number];

export type SsoRefusal =
  | 'provider_unreachable'
  | 'provider_misconfigured'
  | 'provider_refused'
  | 'token_invalid'
  | 'email_unverified'
  | 'domain_not_allowed'
  | 'no_account'
  | 'expired';

export class SsoError extends Error {
  override readonly name = 'SsoError';
  constructor(
    readonly refusal: SsoRefusal,
    message: string,
  ) {
    super(message);
  }
}

export interface SsoDeps {
  readonly fetch?: typeof fetch;
  readonly resolve?: Resolver;
}

// ---- small crypto helpers ---------------------------------------------------------------------

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 16 characters from [a-z0-9], unbiased (rejection sampling): ~82 bits, lists nothing. */
export function newSsoSlug(): string {
  let out = '';
  while (out.length < 16) {
    for (const b of randomBytes(32)) {
      if (b < 252 && out.length < 16) out += ALPHABET.charAt(b % 36);
    }
  }
  return out;
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

// ---- bounded fetches through the egress guard -----------------------------------------------------

async function fetchJson(
  url: string,
  what: string,
  deps: SsoDeps,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  try {
    await assertPublicHttpsUrl(url, what, deps.resolve ?? dnsResolver);
  } catch (error) {
    throw new SsoError('provider_misconfigured', (error as Error).message);
  }
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, {
      ...init,
      // A redirect could lead anywhere; an OpenID provider has no reason to send one here.
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new SsoError('provider_unreachable', `${what} did not answer`);
  }
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_DOC_BYTES)
    throw new SsoError('provider_misconfigured', `${what} answered with too much data`);
  const text = await res.text();
  if (text.length > MAX_DOC_BYTES)
    throw new SsoError('provider_misconfigured', `${what} answered with too much data`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SsoError('provider_misconfigured', `${what} did not answer with JSON`);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new SsoError('provider_misconfigured', `${what} did not answer with an object`);
  if (!res.ok)
    throw new SsoError(
      'provider_refused',
      `${what} refused: HTTP ${String(res.status)}${
        typeof (body as Record<string, unknown>)['error'] === 'string'
          ? ` (${String((body as Record<string, unknown>)['error'])})`
          : ''
      }`,
    );
  return body as Record<string, unknown>;
}

// ---- discovery ------------------------------------------------------------------------------------

export interface Discovery {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly tokenAuth: 'client_secret_basic' | 'client_secret_post';
}

const httpsUrl = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

export async function discover(issuer: string, deps: SsoDeps = {}): Promise<Discovery> {
  const doc = await fetchJson(
    `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
    'the provider discovery document',
    deps,
  );
  // OpenID Connect Discovery §4.3: the document must name exactly the issuer we asked about.
  // Anything else is a different provider, or one pretending.
  if (doc['issuer'] !== issuer)
    throw new SsoError(
      'provider_misconfigured',
      `the provider calls itself ${JSON.stringify(doc['issuer'])}, not ${issuer} — use its exact issuer URL`,
    );
  const authorizationEndpoint = doc['authorization_endpoint'];
  const tokenEndpoint = doc['token_endpoint'];
  const jwksUri = doc['jwks_uri'];
  if (!httpsUrl(authorizationEndpoint) || !httpsUrl(tokenEndpoint) || !httpsUrl(jwksUri))
    throw new SsoError('provider_misconfigured', 'the provider endpoints must all be https');
  const methods = doc['token_endpoint_auth_methods_supported'];
  const supported = Array.isArray(methods) ? methods.filter((m) => typeof m === 'string') : null;
  // The spec's default is client_secret_basic when the provider does not list its methods.
  const tokenAuth =
    supported === null || supported.includes('client_secret_basic')
      ? 'client_secret_basic'
      : supported.includes('client_secret_post')
        ? 'client_secret_post'
        : null;
  if (tokenAuth === null)
    throw new SsoError(
      'provider_misconfigured',
      'the provider supports neither client_secret_basic nor client_secret_post',
    );
  return { issuer, authorizationEndpoint, tokenEndpoint, jwksUri, tokenAuth };
}

export function authorizationUrl(
  d: Discovery,
  p: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly nonce: string;
    readonly codeChallenge: string;
    readonly loginHint?: string;
  },
): string {
  const url = new URL(d.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('state', p.state);
  url.searchParams.set('nonce', p.nonce);
  url.searchParams.set('code_challenge', p.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (p.loginHint !== undefined) url.searchParams.set('login_hint', p.loginHint);
  return url.href;
}

export async function exchangeCode(
  d: Discovery,
  p: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly code: string;
    readonly verifier: string;
    readonly redirectUri: string;
  },
  deps: SsoDeps = {},
): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (d.tokenAuth === 'client_secret_basic')
    // RFC 6749 §2.3.1: form-encode each part before joining them.
    headers['authorization'] = `Basic ${Buffer.from(
      `${encodeURIComponent(p.clientId)}:${encodeURIComponent(p.clientSecret)}`,
    ).toString('base64')}`;
  else {
    form.set('client_id', p.clientId);
    form.set('client_secret', p.clientSecret);
  }
  const body = await fetchJson(d.tokenEndpoint, 'the provider token endpoint', deps, {
    method: 'POST',
    headers,
    body: form.toString(),
  });
  const idToken = body['id_token'];
  if (typeof idToken !== 'string')
    throw new SsoError('provider_refused', 'the provider returned no ID token');
  return idToken;
}

// ---- keys ------------------------------------------------------------------------------------------

export type KeySource = (kid: string, refresh: boolean) => Promise<KeyObject | undefined>;

const jwksCache = new Map<string, { at: number; keys: Map<string, KeyObject> }>();
const JWKS_TTL_MS = 60 * 60_000;
const JWKS_MIN_REFRESH_MS = 60_000;

/** Keys by `kid`, cached an hour; an unknown kid refreshes once (key rotation), at most a minute apart. */
export function jwksKeySource(jwksUri: string, deps: SsoDeps = {}): KeySource {
  return async (kid, refresh) => {
    const cached = jwksCache.get(jwksUri);
    const stale = cached === undefined || Date.now() - cached.at > JWKS_TTL_MS;
    const mayRefresh = cached === undefined || Date.now() - cached.at > JWKS_MIN_REFRESH_MS;
    if (stale || (refresh && mayRefresh)) {
      const doc = await fetchJson(jwksUri, 'the provider key set', deps);
      const keys = new Map<string, KeyObject>();
      for (const k of Array.isArray(doc['keys']) ? (doc['keys'] as unknown[]) : []) {
        const jwk = k as JsonWebKey & { kid?: unknown; use?: unknown };
        if (typeof jwk.kid !== 'string' || (jwk.use !== undefined && jwk.use !== 'sig')) continue;
        try {
          keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
        } catch {
          // A key we cannot read is a key we cannot verify with; skip it.
        }
      }
      jwksCache.set(jwksUri, { at: Date.now(), keys });
      return keys.get(kid);
    }
    return cached.keys.get(kid);
  };
}

// ---- ID token verification -------------------------------------------------------------------------

export interface VerifiedIdentity {
  readonly email: string;
  readonly subject: string;
}

function part(s: string): Record<string, unknown> {
  const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
  return v as Record<string, unknown>;
}

/** The key must be the kind the algorithm names — an RSA key for RS256, a P-256 key for ES256. */
function keyFits(alg: Alg, key: KeyObject): boolean {
  if (alg === 'RS256') return key.asymmetricKeyType === 'rsa';
  return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
}

export async function verifyIdToken(
  token: string,
  expect: {
    readonly issuer: string;
    readonly clientId: string;
    readonly nonce: string;
    readonly nowMs: number;
  },
  keys: KeySource,
): Promise<VerifiedIdentity> {
  const invalid = (why: string) => new SsoError('token_invalid', `ID token ${why}`);
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid('is malformed');
  const [h, p, s] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = part(h);
    claims = part(p);
  } catch {
    throw invalid('is malformed');
  }
  const alg = header['alg'];
  // Never 'none', never an HMAC algorithm (the client secret is not a verification key here).
  if (typeof alg !== 'string' || !(ALGS as readonly string[]).includes(alg))
    throw invalid(`uses an algorithm we do not accept (${String(alg)})`);
  const kid = header['kid'];
  if (typeof kid !== 'string' || kid === '') throw invalid('names no key');
  const key = (await keys(kid, false)) ?? (await keys(kid, true));
  if (key === undefined) throw invalid('is signed with a key the provider does not publish');
  if (!keyFits(alg as Alg, key)) throw invalid('names an algorithm its key cannot use');
  const signed = Buffer.from(`${h}.${p}`);
  const signature = Buffer.from(s, 'base64url');
  const ok =
    alg === 'RS256'
      ? verify('sha256', signed, key, signature)
      : verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature);
  if (!ok) throw invalid('signature does not verify');

  const now = Math.floor(expect.nowMs / 1000);
  if (claims['iss'] !== expect.issuer) throw invalid('was issued by someone else');
  const aud = claims['aud'];
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : [];
  if (!audiences.includes(expect.clientId)) throw invalid('was not issued for this application');
  if (audiences.length > 1 && claims['azp'] !== expect.clientId)
    throw invalid('was issued to another party');
  if (typeof claims['exp'] !== 'number' || claims['exp'] < now - CLOCK_SKEW_SEC)
    throw invalid('has expired');
  if (typeof claims['iat'] !== 'number' || claims['iat'] > now + CLOCK_SKEW_SEC)
    throw invalid('is dated in the future');
  if (typeof claims['nonce'] !== 'string' || claims['nonce'] !== expect.nonce)
    throw invalid('does not belong to this sign-in');
  const subject = claims['sub'];
  if (typeof subject !== 'string' || subject === '') throw invalid('names no subject');
  const email = claims['email'];
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new SsoError('email_unverified', 'the provider did not send an email address');
  if (claims['email_verified'] !== true && claims['xms_edov'] !== true)
    throw new SsoError(
      'email_unverified',
      'the provider did not confirm the email address (email_verified)',
    );
  return { email: email.trim().toLowerCase(), subject };
}

export function emailDomainAllowed(email: string, domains: readonly string[]): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return domains.includes(domain);
}

// ---- the provider behind a link, and the session it opens ----------------------------------------

export interface SsoLoginConfig {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly emailDomains: readonly string[];
}

export interface SsoSecretKey {
  readonly key: Buffer;
  readonly kid: number;
}

export async function ssoConfigBySlug(
  db: Db,
  slug: string,
  secretKey: SsoSecretKey,
): Promise<SsoLoginConfig | null> {
  if (!SSO_SLUG.test(slug)) return null;
  const r = await db.execute<{
    tenant_id: string;
    tenant_name: string;
    issuer: string;
    client_id: string;
    client_secret_enc: Buffer;
    client_secret_iv: Buffer;
    client_secret_tag: Buffer;
    client_secret_kid: number;
    email_domains: string[];
  }>(sql`select * from web_sso_by_slug(${slug})`);
  const row = r.rows[0];
  if (row === undefined) return null;
  if (row.client_secret_kid !== secretKey.kid)
    throw new SsoError('provider_misconfigured', 'the client secret was sealed with another key');
  const clientSecret = openSealed(
    secretKey.key,
    { ciphertext: row.client_secret_enc, iv: row.client_secret_iv, tag: row.client_secret_tag },
    row.tenant_id,
  );
  return {
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecret,
    emailDomains: row.email_domains,
  };
}

export async function openSsoSession(
  db: Db,
  input: {
    readonly tenantId: string;
    readonly email: string;
    readonly userAgent: string | null;
    readonly ipHash: string | null;
    readonly now: Date;
  },
): Promise<OpenedSession | null> {
  const sessionToken = randomToken();
  const sessionId = newId('webSession');
  const expiresAt = new Date(input.now.getTime() + SESSION_ABSOLUTE_DAYS * 86_400_000);
  const r = await db.execute<{ session_id: string; user_id: string }>(
    sql`select * from open_sso_session(${input.tenantId}, ${input.email}, ${sessionId}, ${sha256Hex(sessionToken)}, ${expiresAt}, ${input.userAgent ?? ''}, ${input.ipHash}, ${newId('audit')}, ${input.now})`,
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  return {
    sessionToken,
    sessionId: row.session_id,
    userId: row.user_id,
    tenantId: input.tenantId,
    expiresAt,
  };
}

// ---- owner settings (dashboard, under the tenant's RLS) ------------------------------------------

const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'is not a domain');

export const SsoSettingsInput = z.object({
  issuer: z
    .string()
    .trim()
    .max(500)
    .refine((v) => httpsUrl(v), 'must be an https URL'),
  client_id: z.string().trim().min(1).max(500),
  /** Omitted or empty on an update: the stored secret is kept. */
  client_secret: z.string().max(4000).optional(),
  email_domains: z
    .array(Domain)
    .min(1)
    .max(20)
    .transform((d) => [...new Set(d)].sort()),
});
export type SsoSettingsInput = z.infer<typeof SsoSettingsInput>;

export interface SsoSettingsView {
  readonly slug: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly emailDomains: string[];
  readonly status: 'testing' | 'active' | 'disabled';
  readonly enforced: boolean;
  readonly lastSuccessAt: Date | null;
}

export async function getSsoSettings(tx: Tx, tenantId: string): Promise<SsoSettingsView | null> {
  const [row] = await tx
    .select()
    .from(schema.tenantSso)
    .where(eq(schema.tenantSso.tenantId, tenantId))
    .limit(1);
  if (row === undefined) return null;
  return {
    slug: row.slug,
    issuer: row.issuer,
    clientId: row.clientId,
    emailDomains: row.emailDomains,
    status: row.status,
    enforced: row.enforced,
    lastSuccessAt: row.lastSuccessAt,
  };
}

/**
 * Create or change the provider. The issuer is checked by fetching its discovery document, so a
 * typo fails here with a sentence rather than on a colleague's sign-in. Any change to issuer,
 * client or domains puts it back to `testing` and switches enforcement off: a changed
 * configuration must be proven by a sign-in again before it can lock anyone out.
 */
export async function saveSsoSettings(
  tx: Tx,
  actor: Actor,
  secretKey: SsoSecretKey,
  input: SsoSettingsInput,
  deps: SsoDeps = {},
): Promise<SsoSettingsView> {
  try {
    await discover(input.issuer, deps);
  } catch (error) {
    if (error instanceof SsoError)
      throw new NaaradhError('VALIDATION_FAILED', `issuer: ${error.message}`);
    throw error;
  }
  const [existing] = await tx
    .select()
    .from(schema.tenantSso)
    .where(eq(schema.tenantSso.tenantId, actor.tenantId))
    .limit(1);
  const secret = input.client_secret?.trim() ?? '';
  if (existing === undefined && secret === '')
    throw new NaaradhError('VALIDATION_FAILED', 'client_secret: required the first time');
  const sealed = secret === '' ? null : seal(secretKey.key, secretKey.kid, secret, actor.tenantId);
  const changed =
    existing === undefined ||
    existing.issuer !== input.issuer ||
    existing.clientId !== input.client_id ||
    existing.emailDomains.join(',') !== input.email_domains.join(',') ||
    sealed !== null;
  if (existing === undefined) {
    if (sealed === null) throw new Error('unreachable: a new configuration has a secret');
    await tx.insert(schema.tenantSso).values({
      id: newId('tenantSso'),
      tenantId: actor.tenantId,
      slug: newSsoSlug(),
      issuer: input.issuer,
      clientId: input.client_id,
      clientSecretEnc: sealed.ciphertext,
      clientSecretIv: sealed.iv,
      clientSecretTag: sealed.tag,
      clientSecretKid: sealed.kid,
      emailDomains: input.email_domains,
    });
  } else if (changed) {
    await tx
      .update(schema.tenantSso)
      .set({
        issuer: input.issuer,
        clientId: input.client_id,
        emailDomains: input.email_domains,
        ...(sealed === null
          ? {}
          : {
              clientSecretEnc: sealed.ciphertext,
              clientSecretIv: sealed.iv,
              clientSecretTag: sealed.tag,
              clientSecretKid: sealed.kid,
            }),
        status: 'testing',
        enforced: false,
        lastSuccessAt: null,
      })
      .where(eq(schema.tenantSso.id, existing.id));
  }
  await audit(tx, {
    ...auditActor(actor),
    action: existing === undefined ? 'sso.configured' : 'sso.changed',
    targetType: 'tenant',
    targetId: actor.tenantId,
    before:
      existing === undefined
        ? null
        : {
            issuer: existing.issuer,
            client_id: existing.clientId,
            email_domains: existing.emailDomains,
            status: existing.status,
            enforced: existing.enforced,
          },
    after: {
      issuer: input.issuer,
      client_id: input.client_id,
      email_domains: input.email_domains,
      secret_replaced: sealed !== null,
    },
  });
  const view = await getSsoSettings(tx, actor.tenantId);
  if (view === null) throw new Error('unreachable: the configuration was just written');
  return view;
}

export async function setSsoEnforced(tx: Tx, actor: Actor, enforced: boolean): Promise<void> {
  const view = await getSsoSettings(tx, actor.tenantId);
  if (view === null) throw new NaaradhError('NOT_FOUND', 'single sign-on is not configured');
  if (enforced && (view.status !== 'active' || view.lastSuccessAt === null))
    throw new NaaradhError(
      'VALIDATION_FAILED',
      'sign in once through single sign-on before requiring it for everyone',
    );
  await tx
    .update(schema.tenantSso)
    .set({ enforced })
    .where(eq(schema.tenantSso.tenantId, actor.tenantId));
  await audit(tx, {
    ...auditActor(actor),
    action: enforced ? 'sso.enforced' : 'sso.unenforced',
    targetType: 'tenant',
    targetId: actor.tenantId,
    before: { enforced: view.enforced },
    after: { enforced },
  });
}

export async function setSsoStatus(
  tx: Tx,
  actor: Actor,
  status: 'disabled' | 'testing',
): Promise<void> {
  const view = await getSsoSettings(tx, actor.tenantId);
  if (view === null) throw new NaaradhError('NOT_FOUND', 'single sign-on is not configured');
  await tx
    .update(schema.tenantSso)
    .set({ status, enforced: false, ...(status === 'testing' ? { lastSuccessAt: null } : {}) })
    .where(and(eq(schema.tenantSso.tenantId, actor.tenantId)));
  await audit(tx, {
    ...auditActor(actor),
    action: status === 'disabled' ? 'sso.disabled' : 'sso.reenabled',
    targetType: 'tenant',
    targetId: actor.tenantId,
    before: { status: view.status, enforced: view.enforced },
    after: { status, enforced: false },
  });
}
