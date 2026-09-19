import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadEnv, regionPeersEnv, shopifyTokenEnv } from '../src/index.js';

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
