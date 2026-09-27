import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  SsoError,
  authorizationUrl,
  discover,
  emailDomainAllowed,
  exchangeCode,
  newSsoSlug,
  pkcePair,
  verifyIdToken,
  type KeySource,
} from '../src/index.js';

/**
 * P7-ENT-1: the ID token is verified, never trusted. Each test is one way a token could be
 * forged, replayed or misused, and each must be refused.
 */

const ISSUER = 'https://idp.client-a.example';
const CLIENT = 'naaradh-dashboard';
const NONCE = 'nonce-123';
const NOW = Date.parse('2026-09-28T10:00:00Z');
const t = Math.floor(NOW / 1000);

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const otherRsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

const keys =
  (map: Record<string, KeyObject>): KeySource =>
  async (kid) =>
    map[kid];
const KEYS = keys({ rsa1: rsa.publicKey, ec1: ec.publicKey });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: CLIENT,
  sub: 'user-42',
  email: 'Asha@Client-A.example',
  email_verified: true,
  nonce: NONCE,
  iat: t - 10,
  exp: t + 300,
  ...over,
});

function token(
  body: Record<string, unknown>,
  opts: { alg?: string; kid?: string; key?: KeyObject; raw?: boolean } = {},
): string {
  const alg = opts.alg ?? 'RS256';
  const head = b64({ alg, kid: opts.kid ?? (alg === 'ES256' ? 'ec1' : 'rsa1'), typ: 'JWT' });
  const payload = b64(body);
  const data = Buffer.from(`${head}.${payload}`);
  if (opts.raw === true) return `${head}.${payload}.`;
  const sig =
    alg === 'ES256'
      ? sign('sha256', data, { key: opts.key ?? ec.privateKey, dsaEncoding: 'ieee-p1363' })
      : sign('sha256', data, opts.key ?? rsa.privateKey);
  return `${head}.${payload}.${sig.toString('base64url')}`;
}

const expectOk = { issuer: ISSUER, clientId: CLIENT, nonce: NONCE, nowMs: NOW };
const refused = async (tok: string, why: RegExp, ks: KeySource = KEYS) => {
  await expect(verifyIdToken(tok, expectOk, ks)).rejects.toThrow(why);
};

describe('a genuine token', () => {
  it('RS256: verified, email lower-cased', async () => {
    await expect(verifyIdToken(token(claims()), expectOk, KEYS)).resolves.toEqual({
      email: 'asha@client-a.example',
      subject: 'user-42',
    });
  });
  it('ES256: verified', async () => {
    await expect(
      verifyIdToken(token(claims(), { alg: 'ES256' }), expectOk, KEYS),
    ).resolves.toMatchObject({
      subject: 'user-42',
    });
  });
  it('Microsoft Entra: accepted on xms_edov when email_verified is absent', async () => {
    const { email_verified: _, ...rest } = claims();
    await expect(
      verifyIdToken(token({ ...rest, xms_edov: true }), expectOk, KEYS),
    ).resolves.toMatchObject({ email: 'asha@client-a.example' });
  });
  it('a token a few seconds past exp is inside the clock skew', async () => {
    await expect(
      verifyIdToken(token(claims({ exp: t - 30 })), expectOk, KEYS),
    ).resolves.toBeDefined();
  });
});

describe('forged or misused tokens are refused', () => {
  it('alg none (unsigned)', async () => {
    await refused(token(claims(), { alg: 'none', raw: true }), /algorithm we do not accept/);
  });
  it('HS256 — the client secret is never a verification key', async () => {
    await refused(token(claims(), { alg: 'HS256', raw: true }), /algorithm we do not accept/);
  });
  it('RS256 in the header over an EC key (algorithm confusion)', async () => {
    await refused(token(claims(), { alg: 'RS256', kid: 'ec1' }), /algorithm its key cannot use/);
  });
  it('ES256 in the header over an RSA key', async () => {
    await refused(token(claims(), { alg: 'ES256', kid: 'rsa1' }), /algorithm its key cannot use/);
  });
  it('signed by a key the provider does not publish', async () => {
    await refused(token(claims(), { key: otherRsa.privateKey }), /signature does not verify/);
  });
  it('a payload altered after signing', async () => {
    const [h, , s] = token(claims()).split('.');
    await refused(
      `${h ?? ''}.${b64(claims({ email: 'boss@client-a.example' }))}.${s ?? ''}`,
      /signature/,
    );
  });
  it('an unknown kid, after one refresh of the key set', async () => {
    const source = vi.fn<KeySource>(async () => undefined);
    await refused(token(claims(), { kid: 'rotated-away' }), /does not publish/, source);
    expect(source).toHaveBeenCalledTimes(2);
    expect(source.mock.calls[1]?.[1]).toBe(true);
  });
  it('issued by another provider', async () => {
    await refused(token(claims({ iss: 'https://idp.evil.example' })), /issued by someone else/);
  });
  it('issued for another application', async () => {
    await refused(token(claims({ aud: 'someone-else' })), /not issued for this application/);
  });
  it('several audiences without us as the authorised party', async () => {
    await refused(token(claims({ aud: [CLIENT, 'other'], azp: 'other' })), /another party/);
  });
  it('several audiences with us as azp are fine', async () => {
    await expect(
      verifyIdToken(token(claims({ aud: [CLIENT, 'other'], azp: CLIENT })), expectOk, KEYS),
    ).resolves.toBeDefined();
  });
  it('expired', async () => {
    await refused(token(claims({ exp: t - 3600 })), /expired/);
  });
  it('dated in the future', async () => {
    await refused(token(claims({ iat: t + 3600 })), /future/);
  });
  it('replayed into another sign-in (nonce)', async () => {
    await refused(token(claims({ nonce: 'someone-elses' })), /does not belong to this sign-in/);
  });
  it('no subject', async () => {
    await refused(token(claims({ sub: '' })), /no subject/);
  });
  it('an unverified email (nOAuth): email_verified false', async () => {
    await refused(token(claims({ email_verified: false })), /did not confirm the email/);
  });
  it('an unverified email: neither email_verified nor xms_edov', async () => {
    const { email_verified: _, ...rest } = claims();
    await refused(token(rest), /did not confirm the email/);
  });
  it('the string "true" is not true', async () => {
    await refused(token(claims({ email_verified: 'true' })), /did not confirm the email/);
  });
  it('no email at all', async () => {
    await refused(token(claims({ email: undefined })), /did not send an email/);
  });
  it('garbage', async () => {
    await refused('not.a.token', /malformed/);
    await refused('one-part', /malformed/);
  });
});

describe('email domains', () => {
  it('only the tenant’s own domains', () => {
    expect(emailDomainAllowed('asha@client-a.example', ['client-a.example'])).toBe(true);
    expect(emailDomainAllowed('asha@evil.example', ['client-a.example'])).toBe(false);
    // The last @ decides: an address cannot smuggle an allowed domain in its local part.
    expect(emailDomainAllowed('"x@client-a.example"@evil.example', ['client-a.example'])).toBe(
      false,
    );
  });
});

describe('discovery', () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/keys`,
    ...over,
  });
  const serve = (body: unknown) => async () =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const PUBLIC = async () => ['34.117.59.81'];

  it('reads the endpoints and defaults to client_secret_basic', async () => {
    await expect(discover(ISSUER, { fetch: serve(doc()), resolve: PUBLIC })).resolves.toMatchObject(
      {
        tokenEndpoint: `${ISSUER}/token`,
        tokenAuth: 'client_secret_basic',
      },
    );
  });
  it('uses client_secret_post when that is all the provider offers', async () => {
    const d = await discover(ISSUER, {
      fetch: serve(doc({ token_endpoint_auth_methods_supported: ['client_secret_post'] })),
      resolve: PUBLIC,
    });
    expect(d.tokenAuth).toBe('client_secret_post');
  });
  it('refuses a document that names a different issuer (mix-up)', async () => {
    await expect(
      discover(ISSUER, {
        fetch: serve(doc({ issuer: 'https://idp.evil.example' })),
        resolve: PUBLIC,
      }),
    ).rejects.toThrow(/calls itself/);
  });
  it('refuses a plain-http endpoint', async () => {
    await expect(
      discover(ISSUER, {
        fetch: serve(doc({ token_endpoint: 'http://idp.client-a.example/token' })),
        resolve: PUBLIC,
      }),
    ).rejects.toThrow(/https/);
  });
  it('refuses an issuer that resolves to a private address (SSRF)', async () => {
    await expect(
      discover(ISSUER, { fetch: serve(doc()), resolve: async () => ['169.254.169.254'] }),
    ).rejects.toThrow(/private address/);
  });
  it('refuses an issuer on our own domain', async () => {
    await expect(
      discover('https://api.naaradh.com', { fetch: serve(doc()), resolve: PUBLIC }),
    ).rejects.toThrow(/not allowed/);
  });
  it('never follows a redirect', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response('{}'));
    await discover(ISSUER, { fetch: f, resolve: PUBLIC }).catch(() => undefined);
    expect(f.mock.calls[0]?.[1]?.redirect).toBe('error');
  });
});

describe('the authorization request and the code exchange', () => {
  const disc = {
    issuer: ISSUER,
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    jwksUri: `${ISSUER}/keys`,
    tokenAuth: 'client_secret_basic' as const,
  };

  it('asks for a code with PKCE S256, state and nonce', () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    const url = new URL(
      authorizationUrl(disc, {
        clientId: CLIENT,
        redirectUri: 'https://app.naaradh.com/auth/sso/callback',
        state: 's',
        nonce: 'n',
        codeChallenge: challenge,
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      scope: 'openid email',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
      nonce: 'n',
    });
  });

  it('sends the verifier, and client credentials form-encoded in Basic auth', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id_token: 'x.y.z' })));
    await exchangeCode(
      disc,
      {
        clientId: 'id:with',
        clientSecret: 's%cret',
        code: 'c',
        verifier: 'v',
        redirectUri: 'https://r',
      },
      { fetch: f, resolve: async () => ['34.117.59.81'] },
    );
    const init = f.mock.calls[0]?.[1];
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe('id%3Awith:s%25cret');
    const sent = init?.body as string;
    expect(sent).toContain('code_verifier=v');
    expect(sent).not.toContain('client_secret');
  });

  it('refuses a token response with no ID token', async () => {
    await expect(
      exchangeCode(
        disc,
        { clientId: CLIENT, clientSecret: 's', code: 'c', verifier: 'v', redirectUri: 'https://r' },
        { fetch: async () => new Response('{}'), resolve: async () => ['34.117.59.81'] },
      ),
    ).rejects.toThrow(SsoError);
  });
});

describe('the sign-in link', () => {
  it('is 16 characters of [a-z0-9] and does not repeat', () => {
    const slugs = new Set(Array.from({ length: 500 }, () => newSsoSlug()));
    expect(slugs.size).toBe(500);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9]{16}$/);
  });
});
