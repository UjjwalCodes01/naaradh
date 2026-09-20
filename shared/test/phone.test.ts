import { describe, expect, it } from 'vitest';
import {
  decryptPhone,
  dialRejectReason,
  encryptPhone,
  generatePhoneKeyPair,
  hashPhone,
  isDialable,
  maskPhone,
  normalizePhone,
  type ParsedPhone,
} from '../src/phone.js';
import { FAKE_IN, FAKE_UK, FAKE_US, INVALID_PHONES } from './fake-phones.js';

describe('normalizePhone', () => {
  it('accepts an E.164 Indian mobile and reports region IN', () => {
    const r = normalizePhone(FAKE_IN.customer);
    expect(r).toMatchObject({
      ok: true,
      phone: { e164: FAKE_IN.customer, region: 'IN', type: 'mobile' },
    });
  });

  it('normalises national formats using the merchant region only as a default', () => {
    expect(normalizePhone('60000 00001', 'IN')).toMatchObject({
      ok: true,
      phone: { e164: FAKE_IN.customer },
    });
    expect(normalizePhone('+91-60000-00001', 'US')).toMatchObject({
      ok: true,
      phone: { e164: FAKE_IN.customer, region: 'IN' },
    });
    // An IDD prefix ("00") is only meaningful relative to a region.
    expect(normalizePhone('0091 6000000001', 'IN')).toMatchObject({
      ok: true,
      phone: { e164: FAKE_IN.customer },
    });
    expect(normalizePhone('0091 6000000001')).toEqual({ ok: false, reason: 'unparseable' });
  });

  it('applies the spec rule for India: 6-9 then nine digits, nothing else (E-26)', () => {
    expect(normalizePhone(INVALID_PHONES.wrongIndianPrefix)).toEqual({
      ok: false,
      reason: 'india_not_mobile',
    });
    expect(normalizePhone(INVALID_PHONES.tooShort)).toMatchObject({ ok: false });
  });

  it('rejects input with no country context', () => {
    expect(normalizePhone(INVALID_PHONES.notE164)).toMatchObject({ ok: false });
    expect(normalizePhone('')).toEqual({ ok: false, reason: 'unparseable' });
    expect(normalizePhone('hello')).toEqual({ ok: false, reason: 'unparseable' });
  });

  it('parses the US and UK reserved ranges with their own regions (invariant 2)', () => {
    expect(normalizePhone(FAKE_US.customer)).toMatchObject({
      ok: true,
      phone: { region: 'US', allocated: true },
    });
    // Ofcom's drama range is deliberately unallocated in libphonenumber's metadata: region
    // must still resolve (from +44) and the number must still be usable, with allocated=false.
    expect(normalizePhone(FAKE_UK.customer)).toMatchObject({
      ok: true,
      phone: { region: 'GB', allocated: false },
    });
  });

  it('rejects structurally impossible numbers for a region', () => {
    expect(normalizePhone('+4477009')).toMatchObject({ ok: false });
  });
});

describe('dialRejectReason (gate step 4 / universal rule 9)', () => {
  const manual = (
    e164: string,
    region: ParsedPhone['region'],
    rawType?: ParsedPhone['rawType'],
  ): ParsedPhone => ({
    e164,
    region,
    type: 'unknown',
    rawType,
    allocated: false,
  });

  it('refuses emergency numbers in every region we route', () => {
    expect(dialRejectReason(manual('+91112', 'IN'))).toBe('emergency');
    expect(dialRejectReason(manual('+1911', 'US'))).toBe('emergency');
    expect(dialRejectReason(manual('+44999', 'GB'))).toBe('emergency');
  });

  it('refuses short codes', () => {
    expect(dialRejectReason(manual('+9157575', 'IN'))).toBe('short_code');
  });

  it('refuses premium-rate and shared-cost numbers by type', () => {
    const premium = normalizePhone(INVALID_PHONES.premiumRate);
    expect(premium.ok).toBe(true);
    if (premium.ok) expect(dialRejectReason(premium.phone)).toBe('premium_rate');
    expect(dialRejectReason(manual('+441234567890', 'GB', 'SHARED_COST'))).toBe('shared_cost'); // naaradh-pii-allow: synthetic, type forced
  });

  it('allows the reserved fake mobiles', () => {
    for (const n of [FAKE_IN.customer, FAKE_US.customer, FAKE_UK.customer]) {
      const r = normalizePhone(n);
      expect(r.ok, n).toBe(true);
      if (r.ok) expect(isDialable(r.phone), n).toBe(true);
    }
  });
});

describe('hashPhone', () => {
  const key = 'k'.repeat(32);

  it('is deterministic, 64 hex chars, and keyed', () => {
    const a = hashPhone(FAKE_IN.customer, key);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPhone(FAKE_IN.customer, key)).toBe(a);
    expect(hashPhone(FAKE_IN.customer, 'x'.repeat(32))).not.toBe(a);
    expect(hashPhone(FAKE_IN.customerAlt, key)).not.toBe(a);
  });

  it('refuses anything that is not E.164, so a formatting difference cannot fork a suppression', () => {
    expect(() => hashPhone('60000 00001', key)).toThrow(TypeError);
  });
});

describe('maskPhone', () => {
  it('keeps country code, two leading and three trailing digits', () => {
    expect(maskPhone(FAKE_IN.customer)).toBe('+91 60xxx xx001');
    expect(maskPhone(FAKE_US.customer)).toBe('+1 21xxx xx100');
    expect(maskPhone(FAKE_UK.customer)).toBe('+44 77xxx xx001');
  });

  it('never reveals enough to dial', () => {
    const masked = maskPhone(FAKE_IN.customer);
    expect(masked.replace(/\D/g, '').length).toBeLessThan(FAKE_IN.customer.length - 3);
  });
});

describe('encryptPhone / decryptPhone (asymmetric, AGENTS §4)', () => {
  const keys = generatePhoneKeyPair();

  it('round-trips and tags the key version', () => {
    const enc = encryptPhone(FAKE_IN.customer, keys.publicKeyPem, 3);
    expect(enc.kid).toBe(3);
    expect(decryptPhone(enc.ciphertext, keys.privateKeyPem)).toBe(FAKE_IN.customer);
  });

  it('produces different ciphertext each time (OAEP), so ciphertext is not a lookup key', () => {
    const a = encryptPhone(FAKE_IN.customer, keys.publicKeyPem, 1).ciphertext;
    const b = encryptPhone(FAKE_IN.customer, keys.publicKeyPem, 1).ciphertext;
    expect(a.equals(b)).toBe(false);
  });

  it('cannot be decrypted with another key', () => {
    const other = generatePhoneKeyPair();
    const enc = encryptPhone(FAKE_IN.customer, keys.publicKeyPem, 1);
    expect(() => decryptPhone(enc.ciphertext, other.privateKeyPem)).toThrow();
  });

  it('refuses to encrypt a non-E.164 value', () => {
    expect(() => encryptPhone('6000000001', keys.publicKeyPem, 1)).toThrow(TypeError);
  });
});
