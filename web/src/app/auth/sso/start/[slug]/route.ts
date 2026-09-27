import { NextResponse } from 'next/server';
import {
  SSO_SLUG,
  SSO_STATE_TTL_SEC,
  SsoError,
  authorizationUrl,
  discover,
  pkcePair,
  randomToken,
  ssoConfigBySlug,
} from '@naaradh/pipeline';
import { sha256Hex } from '@naaradh/shared';
import { env } from '@/lib/env';
import { allow } from '@/lib/rate-limit';
import { clientIp } from '@/lib/request';
import { db, log, redis } from '@/lib/server';
import { ssoCookieName, ssoKey, ssoRedirectUri, ssoStateKey } from '@/lib/sso';

export const dynamic = 'force-dynamic';

/**
 * GET /auth/sso/start/:slug — begin a single sign-on (P7-ENT-1). The slug is the tenant's own
 * sign-in link; nobody is found by the email domain they type (see pipeline/src/sso.ts).
 *
 * Starting on GET is deliberate: it changes nothing but a short-lived Redis entry, and a GET
 * link is what lets the next hop leave for the provider under `form-action 'self'`.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const back = (reason: string) =>
    NextResponse.redirect(`${env().APP_URL}/login?sso=${reason}`, 303);
  const { slug } = await params;
  if (!SSO_SLUG.test(slug)) return back('expired');
  const key = ssoKey();
  if (key === null) return back('unavailable');
  if (!(await allow(`sso-start-ip:${await clientIp()}`, 30, 3600, { failClosed: true })))
    return new NextResponse('Too many sign-in attempts. Try again later.', { status: 429 });

  try {
    const config = await ssoConfigBySlug(db(), slug, key);
    if (config === null) return back('expired');
    const d = await discover(config.issuer);
    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = pkcePair();
    await redis().set(
      ssoStateKey(sha256Hex(state)),
      JSON.stringify({ slug, tenantId: config.tenantId, nonce, verifier }),
      'EX',
      SSO_STATE_TTL_SEC,
    );
    const res = NextResponse.redirect(
      authorizationUrl(d, {
        clientId: config.clientId,
        redirectUri: ssoRedirectUri(),
        state,
        nonce,
        codeChallenge: challenge,
      }),
      303,
    );
    res.cookies.set(ssoCookieName(), state, {
      httpOnly: true,
      secure: env().NODE_ENV === 'production',
      // Lax, not Strict: the provider sends the browser back to us as a top-level GET from its
      // own origin, and a Strict cookie would not come with it.
      sameSite: 'lax',
      path: '/',
      maxAge: SSO_STATE_TTL_SEC,
    });
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  } catch (error) {
    if (error instanceof SsoError) {
      log().warn({ refusal: error.refusal, slug }, 'sso start refused');
      return back(error.refusal);
    }
    throw error;
  }
}
