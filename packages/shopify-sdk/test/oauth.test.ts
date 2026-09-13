import { describe, expect, it } from 'vitest';
import { ShopifyAuthError, ShopifyRetryableError } from '../src/admin-client.js';
import { refreshOfflineToken } from '../src/oauth.js';

const now = new Date('2026-09-14T06:30:00Z');

function reply(status: number, body: unknown) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      body:
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

const base = {
  shop: 'client-a-dev.myshopify.com',
  clientId: 'cid',
  clientSecret: 'csecret',
  refreshToken: 'rt-1',
  now,
};

describe('expiring offline token refresh', () => {
  it('sends the refresh grant and returns the rotated pair with absolute expiries', async () => {
    const f = reply(200, {
      access_token: 'shpat_new',
      refresh_token: 'rt-2',
      expires_in: 3600,
      refresh_token_expires_in: 7_776_000,
      scope: 'read_orders',
    });
    const r = await refreshOfflineToken({ ...base, fetchImpl: f.fetchImpl });
    expect(f.calls[0]?.url).toBe('https://client-a-dev.myshopify.com/admin/oauth/access_token');
    expect(f.calls[0]?.body).toEqual({
      client_id: 'cid',
      client_secret: 'csecret',
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
    });
    expect(r).toMatchObject({
      accessToken: 'shpat_new',
      refreshToken: 'rt-2',
      scope: 'read_orders',
    });
    expect(r.expiresAt.toISOString()).toBe('2026-09-14T07:30:00.000Z');
  });

  it('401 means reconnect; 5xx is retryable; shop domain is validated', async () => {
    await expect(
      refreshOfflineToken({
        ...base,
        fetchImpl: reply(401, { error: 'invalid_request' }).fetchImpl,
      }),
    ).rejects.toBeInstanceOf(ShopifyAuthError);
    await expect(
      refreshOfflineToken({ ...base, fetchImpl: reply(503, {}).fetchImpl }),
    ).rejects.toBeInstanceOf(ShopifyRetryableError);
    await expect(
      refreshOfflineToken({
        ...base,
        shop: 'evil.example.com',
        fetchImpl: reply(200, {}).fetchImpl,
      }),
    ).rejects.toThrow(/invalid shop/);
  });
});
