import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@naaradh/db';
import { startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import { loadShopifySession, storeShopifySession } from '@naaradh/pipeline';
import { ShopifyAuthError } from '@naaradh/shopify-sdk';
import { inlineSecretResolver } from '../../src/deliveries/secrets.js';
import { shopifyTokenResolver } from '../../src/shopify-tokens.js';

/**
 * Expiring offline tokens (ADR-0007): the workers' resolver refreshes a token that is about to
 * expire, exactly once under concurrency, stores the rotated pair sealed, and treats a dead
 * refresh token as "reconnect the store".
 */

const shop = 'client-a-dev.myshopify.com';
const id = `offline_${shop}`;
const key = randomBytes(32);
const keys = new Map([[1, key]]);
let now = new Date('2026-09-14T06:30:00Z');

let pg: TestPostgres;
let app: Db;
let service: Db;
const closers: (() => Promise<void>)[] = [];

function shopifyOAuth() {
  let calls = 0;
  let status = 200;
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 30));
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      refresh_token: string;
    };
    if (status !== 200)
      return new Response(JSON.stringify({ error: 'invalid_request' }), { status });
    return new Response(
      JSON.stringify({
        access_token: `shpat_after_${body.refresh_token}`,
        refresh_token: `${body.refresh_token}+`,
        expires_in: 3600,
        refresh_token_expires_in: 7_776_000,
      }),
      { status: 200 },
    );
  };
  return {
    fetchImpl,
    calls: () => calls,
    fail: (s: number) => {
      status = s;
    },
  };
}

async function seed(expires: Date | null, refreshToken: string | null) {
  await storeShopifySession(
    app,
    { key, kid: 1 },
    {
      id,
      shop,
      state: '',
      isOnline: false,
      scope: 'read_orders',
      expires,
      accessToken: 'shpat_before',
      refreshToken,
      refreshTokenExpires: null,
    },
  );
}

beforeAll(async () => {
  pg = await startTestPostgres();
  const a = createDb({ url: pg.urls.app, max: 2 });
  const s = createDb({ url: pg.urls.service, max: 4 });
  app = a.db;
  service = s.db;
  closers.push(a.close, s.close);
}, 180_000);

afterAll(async () => {
  for (const c of closers) await c();
  await pg.stop();
});

describe('shopify-session: credential refs', () => {
  it('a live token is used as stored; other refs go to the base resolver', async () => {
    await seed(new Date(now.getTime() + 30 * 60_000), 'rt');
    const oauth = shopifyOAuth();
    const r = shopifyTokenResolver(inlineSecretResolver(), {
      service,
      keys,
      currentKid: 1,
      clientId: 'cid',
      clientSecret: 'secret',
      now: () => now,
      fetchImpl: oauth.fetchImpl,
    });
    expect(await r.resolve(`shopify-session:${id}`)).toBe('shpat_before');
    expect(await r.resolve('inline:whsec_x')).toBe('whsec_x');
    expect(oauth.calls()).toBe(0);
  });

  it('an expiring token is refreshed once even when several workers ask at the same time', async () => {
    await seed(new Date(now.getTime() + 2 * 60_000), 'rt');
    const oauth = shopifyOAuth();
    const r = shopifyTokenResolver(inlineSecretResolver(), {
      service,
      keys,
      currentKid: 1,
      clientId: 'cid',
      clientSecret: 'secret',
      now: () => now,
      fetchImpl: oauth.fetchImpl,
    });
    const tokens = await Promise.all([1, 2, 3].map(() => r.resolve(`shopify-session:${id}`)));
    expect(new Set(tokens)).toEqual(new Set(['shpat_after_rt']));
    expect(oauth.calls()).toBe(1);
    const stored = await loadShopifySession(app, keys, id);
    expect(stored).toMatchObject({ accessToken: 'shpat_after_rt', refreshToken: 'rt+' });
    expect(stored?.expires?.toISOString()).toBe('2026-09-14T07:30:00.000Z');
  });

  it('a dead refresh token means reconnect, and no token without a refresh token is invented', async () => {
    now = new Date('2026-09-14T09:00:00Z');
    const oauth = shopifyOAuth();
    oauth.fail(401);
    const r = shopifyTokenResolver(inlineSecretResolver(), {
      service,
      keys,
      currentKid: 1,
      clientId: 'cid',
      clientSecret: 'secret',
      now: () => now,
      fetchImpl: oauth.fetchImpl,
    });
    await expect(r.resolve(`shopify-session:${id}`)).rejects.toBeInstanceOf(ShopifyAuthError);
    await seed(new Date(now.getTime() - 60_000), null);
    await expect(r.resolve(`shopify-session:${id}`)).rejects.toBeInstanceOf(ShopifyAuthError);
    await expect(r.resolve('shopify-session:offline_unknown.myshopify.com')).rejects.toBeInstanceOf(
      ShopifyAuthError,
    );
  });
});
