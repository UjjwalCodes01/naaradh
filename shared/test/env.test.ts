import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadEnv, regionPeersEnv, shopifyTokenEnv, trustProxyOf } from '../src/index.js';

describe('loadEnv', () => {
  it('treats `KEY=` (blank, as copied from .env.example) as not set', () => {
    const schema = z.object({
      ...shopifyTokenEnv,
      ...regionPeersEnv,
      STRIPE_SECRET_KEY: z
        .string()
        .regex(/^sk_(test|live)_/)
        .optional(),
    });
    const env = loadEnv(schema, {
      SHOPIFY_TOKEN_KEY: Buffer.alloc(32, 1).toString('base64'),
      SHOPIFY_TOKEN_KEY_PREVIOUS: '',
      SHOPIFY_TOKEN_KID_PREVIOUS: '',
      REGION_PEERS: '',
      REGION_SYNC_PRIVATE_KEY: '  ',
      REGION_PEER_KEYS: '',
      STRIPE_SECRET_KEY: '',
    });
    expect(env.SHOPIFY_TOKEN_KEY_PREVIOUS).toBeUndefined();
    expect(env.REGION_PEERS).toEqual({});
    expect(env.REGION_SYNC_PRIVATE_KEY).toBeUndefined();
    expect(env.REGION_PEER_KEYS).toEqual({});
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it('a blank REQUIRED variable is still reported as missing', () => {
    expect(() =>
      loadEnv(z.object({ PHONE_HASH_KEY: z.string().min(32) }), { PHONE_HASH_KEY: '' }),
    ).toThrow(/PHONE_HASH_KEY/);
  });
});

describe('trustProxyOf (TRUST_PROXY_HOPS)', () => {
  it('trusts exactly as many hops as configured, counting from the socket peer', () => {
    // Fastify calls this for each address in the chain: hop 0 is the peer that opened the
    // socket (our load balancer), hop 1 the entry it appended to X-Forwarded-For, and so on.
    const trust = trustProxyOf(2);
    expect(typeof trust).toBe('function');
    if (typeof trust !== 'function') return;
    expect(trust('10.0.0.1', 0)).toBe(true);
    expect(trust('10.0.0.2', 1)).toBe(true);
    // A third entry is whatever the client sent, so it can never be trusted.
    expect(trust('203.0.113.7', 2)).toBe(false);
    expect(trust('203.0.113.7', 9)).toBe(false);
  });

  it('never returns a number — fastify reads that as trust nothing', () => {
    // A numeric trustProxy makes every request's ip the load balancer's, which silently
    // collapses every per-IP rate limit into one bucket.
    for (const hops of [1, 2, 10]) expect(typeof trustProxyOf(hops)).toBe('function');
  });

  it('trusts nothing when no proxy is configured', () => {
    expect(trustProxyOf(undefined)).toBe(false);
    expect(trustProxyOf(0)).toBe(false);
    expect(trustProxyOf(-1)).toBe(false);
  });
});
