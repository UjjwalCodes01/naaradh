import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { open, parseSecretKey, seal } from '../src/secretbox.js';

describe('secretbox (ADR-0007 token encryption)', () => {
  const key = randomBytes(32);

  it('round-trips with the same key and AAD', () => {
    const s = seal(key, 1, 'shpat_example_token', 'offline_client-a-dev.myshopify.com');
    expect(s.iv).toHaveLength(12);
    expect(s.tag).toHaveLength(16);
    expect(s.ciphertext.toString('utf8')).not.toContain('shpat');
    expect(open(key, s, 'offline_client-a-dev.myshopify.com')).toBe('shpat_example_token');
  });

  it('a ciphertext moved to another row (different AAD) does not open', () => {
    const s = seal(key, 1, 'shpat_example_token', 'offline_a.myshopify.com');
    expect(() => open(key, s, 'offline_b.myshopify.com')).toThrow();
  });

  it('a wrong key or a flipped byte does not open', () => {
    const s = seal(key, 1, 'secret', 'aad');
    expect(() => open(randomBytes(32), s, 'aad')).toThrow();
    const tampered = Buffer.from(s.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() => open(key, { ...s, ciphertext: tampered }, 'aad')).toThrow();
  });

  it('keys must be exactly 32 bytes', () => {
    expect(parseSecretKey(randomBytes(32).toString('base64'))).toHaveLength(32);
    expect(() => parseSecretKey(randomBytes(16).toString('base64'))).toThrow();
  });
});
