import { ShopifyAuthError, ShopifyRequestError, ShopifyRetryableError } from './admin-client.js';

/**
 * Expiring offline access tokens (ADR-0007). New public apps receive offline tokens that live
 * one hour, with a 90-day refresh token; every refresh ROTATES the refresh token, and any
 * other grant (the embedded app's token exchange) invalidates the previous one. Workers that
 * call Shopify while no merchant is in the app refresh through here.
 *
 *   POST https://{shop}/admin/oauth/access_token
 *   { client_id, client_secret, grant_type: "refresh_token", refresh_token }
 *   → { access_token, refresh_token, expires_in, refresh_token_expires_in, scope? }
 *
 * An unusable refresh token (replaced, expired, revoked, app uninstalled) answers 401
 * `invalid_request` — ShopifyAuthError: the store must reopen the app.
 */

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export interface RefreshedToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
  readonly refreshTokenExpiresAt: Date | null;
  readonly scope: string | null;
}

export async function refreshOfflineToken(input: {
  readonly shop: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly now: Date;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<RefreshedToken> {
  if (!SHOP_DOMAIN.test(input.shop)) throw new ShopifyRequestError('invalid shop domain');
  const doFetch = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`https://${input.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new ShopifyRetryableError(
      `network error refreshing token: ${error instanceof Error ? error.name : 'unknown'}`,
    );
  }
  if (res.status === 401 || res.status === 403) throw new ShopifyAuthError(res.status);
  if (res.status === 429 || res.status >= 500)
    throw new ShopifyRetryableError(`token refresh HTTP ${String(res.status)}`);
  const body = (await res.json().catch(() => null)) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    refresh_token_expires_in?: unknown;
    scope?: unknown;
  } | null;
  if (
    !res.ok ||
    body === null ||
    typeof body.access_token !== 'string' ||
    typeof body.refresh_token !== 'string' ||
    typeof body.expires_in !== 'number'
  )
    throw new ShopifyRequestError(`token refresh failed (HTTP ${String(res.status)})`);
  const at = input.now.getTime();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(at + body.expires_in * 1000),
    refreshTokenExpiresAt:
      typeof body.refresh_token_expires_in === 'number'
        ? new Date(at + body.refresh_token_expires_in * 1000)
        : null,
    scope: typeof body.scope === 'string' ? body.scope : null,
  };
}
