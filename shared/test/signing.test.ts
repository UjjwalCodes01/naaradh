import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateApiKey,
  hashApiKey,
  parseApiKeyEnv,
  signMerchantWebhook,
  verifyMerchantWebhook,
  verifyShopifyHmac,
} from '../src/signing.js';

describe('merchant webhook signatures (AGENTS §8)', () => {
  const secret = 'whsec_test_secret';
  const body = '{"event":"outcome.final","id":"evt_1"}';
  const now = 1_800_000_000;

  it('round-trips', () => {
    const header = signMerchantWebhook(secret, body, now);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyMerchantWebhook(secret, header, body, now + 10)).toEqual({ ok: true });
  });

  it('rejects a replay outside the 5-minute window', () => {
    const header = signMerchantWebhook(secret, body, now);
    expect(verifyMerchantWebhook(secret, header, body, now + 301)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyMerchantWebhook(secret, header, body, now - 301)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a tampered body and a wrong secret', () => {
    const header = signMerchantWebhook(secret, body, now);
    expect(verifyMerchantWebhook(secret, header, body + ' ', now)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyMerchantWebhook('other', header, body, now)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects malformed headers without throwing', () => {
    expect(verifyMerchantWebhook(secret, undefined, body, now)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyMerchantWebhook(secret, 'garbage', body, now)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyMerchantWebhook(secret, 't=abc,v1=def', body, now)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('Shopify HMAC (invariant 9)', () => {
  const secret = 'shpss_test';
  const raw = Buffer.from('{"id":1}');

  it('accepts the base64 digest over the raw bytes', () => {
    const header = createHmac('sha256', secret).update(raw).digest('base64');
    expect(verifyShopifyHmac(secret, raw, header)).toBe(true);
  });

  it('rejects a digest over re-serialised bytes, a missing header, and an empty header', () => {
    const header = createHmac('sha256', secret).update('{"id": 1}').digest('base64');
    expect(verifyShopifyHmac(secret, raw, header)).toBe(false);
    expect(verifyShopifyHmac(secret, raw, undefined)).toBe(false);
    expect(verifyShopifyHmac(secret, raw, '')).toBe(false);
  });
});

describe('API keys (E-70)', () => {
  it('generates a prefixed key whose hash — not the key — is what gets stored', () => {
    const k = generateApiKey('live');
    expect(k.key).toMatch(/^nrd_live_[A-Za-z0-9]{32}$/);
    expect(k.prefix).toBe(k.key.slice(0, 12));
    expect(k.keyHash).toBe(hashApiKey(k.key));
    expect(k.keyHash).not.toContain(k.key.slice(9));
  });

  it('parses the environment out of a key and rejects other shapes', () => {
    expect(parseApiKeyEnv(generateApiKey('pk').key)).toBe('pk');
    expect(parseApiKeyEnv('nrd_live_short')).toBeNull();
    expect(parseApiKeyEnv('sk_live_' + 'a'.repeat(32))).toBeNull();
  });
});
