import { describe, expect, it } from 'vitest';
import { generatePhoneKeyPair } from '@naaradh/shared';
import { loadVoiceEnv } from '../src/env.js';

const customer = generatePhoneKeyPair();
const staff = generatePhoneKeyPair();
const base = {
  DATABASE_URL: 'postgres://naaradh_app:x@localhost:55432/naaradh_dev',
  REDIS_URL: 'redis://localhost:56379',
  PHONE_HASH_KEY: 'h'.repeat(32),
  PHONE_ENC_PUBLIC_KEY: customer.publicKeyPem,
  STAFF_ENC_PRIVATE_KEY: staff.privateKeyPem,
  ENGINE_WEBHOOK_KEY: 'k'.repeat(32),
};

describe('voice env (invariant 19)', () => {
  it('boots with the customer PUBLIC key and the STAFF private key', () => {
    const env = loadVoiceEnv(base);
    expect(env.PORT).toBe(3003);
    expect(env.VOICE_BASE_URL).toBe('http://localhost:3003');
  });

  it('refuses to boot in production with the customer PRIVATE key mounted', () => {
    expect(() =>
      loadVoiceEnv({
        ...base,
        NODE_ENV: 'production',
        PHONE_ENC_PRIVATE_KEY: customer.privateKeyPem,
      }),
    ).toThrow(/PHONE_ENC_PRIVATE_KEY/);
  });

  it('boots locally with one shared .env.local (the key is present but never read)', () => {
    expect(loadVoiceEnv({ ...base, PHONE_ENC_PRIVATE_KEY: customer.privateKeyPem }).NODE_ENV).toBe(
      'development',
    );
  });

  it('refuses to boot without the staff key (transfers would be impossible)', () => {
    const { STAFF_ENC_PRIVATE_KEY: _omit, ...rest } = base;
    expect(() => loadVoiceEnv(rest)).toThrow(/STAFF_ENC_PRIVATE_KEY/);
  });
});
