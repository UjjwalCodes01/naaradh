import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  SsoError,
  discover,
  emailDomainAllowed,
  exchangeCode,
  jwksKeySource,
  openSsoSession,
  ssoConfigBySlug,
  verifyIdToken,
  type SsoRefusal,
} from '@naaradh/pipeline';
import { sha256Hex, timingSafeEqualString } from '@naaradh/shared';
import { env } from '@/lib/env';
import { clientIpHash, userAgent } from '@/lib/request';
import { db, log, now, redis } from '@/lib/server';
import { sessionCookieName } from '@/lib/session';
import { ssoCookieName, ssoKey, ssoRedirectUri, ssoStateKey } from '@/lib/sso';

export const dynamic = 'force-dynamic';

interface Pending {
  readonly slug: string;
  readonly tenantId: string;
  readonly nonce: string;
  readonly verifier: string;
}

/**
 * GET /auth/sso/callback — the provider sends the browser back here (P7-ENT-1).
 *
 * In order: the `state` in the URL must equal the one in this browser's cookie (a sign-in cannot
 * be finished in someone else's browser — login CSRF), and must still be pending in Redis, which
 * is spent on first use (a callback cannot be replayed). Then the code is exchanged with the
 * PKCE verifier, the ID token verified, the email checked against the tenant's domains, and the
 * database opens a session only for an enabled user of that tenant — it never creates one.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const jar = await cookies();
  const fail = (reason: SsoRefusal, tenantId: string | null = null) => {
    if (reason !== 'expired') log().warn({ refusal: reason, tenant_id: tenantId }, 'sso refused');
    const res = NextResponse.redirect(`${env().APP_URL}/login?sso=${reason}`, 303);
    res.cookies.delete(ssoCookieName());
    return res;
  };

  const state = url.searchParams.get('state') ?? '';
  const bound = jar.get(ssoCookieName())?.value ?? '';
  if (state === '' || bound === '' || !timingSafeEqualString(state, bound)) return fail('expired');
  const raw = await redis().getdel(ssoStateKey(sha256Hex(state)));
  if (raw === null) return fail('expired');
  const pending = JSON.parse(raw) as Pending;

  // The provider declined (the person cancelled, or is not assigned to the application).
  if (url.searchParams.get('error') !== null) return fail('provider_refused', pending.tenantId);
  const code = url.searchParams.get('code');
  if (code === null || code === '') return fail('provider_refused', pending.tenantId);

  const key = ssoKey();
  if (key === null) return fail('provider_misconfigured', pending.tenantId);
  try {
    // Read again rather than trusting what the start saw: it may have been switched off since.
    const config = await ssoConfigBySlug(db(), pending.slug, key);
    if (config === null || config.tenantId !== pending.tenantId)
      return fail('expired', pending.tenantId);
    const d = await discover(config.issuer);
    const idToken = await exchangeCode(d, {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      verifier: pending.verifier,
      redirectUri: ssoRedirectUri(),
    });
    const identity = await verifyIdToken(
      idToken,
      {
        issuer: config.issuer,
        clientId: config.clientId,
        nonce: pending.nonce,
        nowMs: now().getTime(),
      },
      jwksKeySource(d.jwksUri),
    );
    if (!emailDomainAllowed(identity.email, config.emailDomains))
      return fail('domain_not_allowed', config.tenantId);
    const session = await openSsoSession(db(), {
      tenantId: config.tenantId,
      email: identity.email,
      userAgent: await userAgent(),
      ipHash: await clientIpHash(),
      now: now(),
    });
    if (session === null) return fail('no_account', config.tenantId);

    const res = NextResponse.redirect(`${env().APP_URL}/app`, 303);
    res.cookies.set(sessionCookieName(), session.sessionToken, {
      httpOnly: true,
      secure: env().NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
    });
    res.cookies.delete(ssoCookieName());
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  } catch (error) {
    if (error instanceof SsoError) return fail(error.refusal, pending.tenantId);
    throw error;
  }
}
