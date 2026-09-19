import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FAKE_IN,
  FAKE_PHONE_PREFIXES,
  FAKE_UK,
  FAKE_US,
  INVALID_PHONES,
  assertFakePhone,
  isFakePhone,
} from './fake-phones.js';

/** The rule the gate enforces at step 4 for +91 recipients. */
const INDIAN_MOBILE = /^\+91[6-9]\d{9}$/;

/**
 * Numbers that look real and are NOT in a reserved range. Declared once, with the allow
 * marker, because their whole purpose is to be rejected: every assertion below checks that
 * something refuses them. Do not add more of these — reuse these two.
 */
const OUT_OF_RANGE_IN = '+916100000001'; // naaradh-pii-allow: negative fixture, asserted to be refused
const OUT_OF_RANGE_US = '+12125551234'; // naaradh-pii-allow: outside the NANP fictitious block

describe('fake phone ranges', () => {
  it('classifies every declared test number as fake', () => {
    for (const number of [
      ...Object.values(FAKE_IN),
      ...Object.values(FAKE_US),
      ...Object.values(FAKE_UK),
    ]) {
      expect(isFakePhone(number), number).toBe(true);
    }
  });

  it('classifies numbers outside the reserved prefixes as not fake', () => {
    // Same shape as a real Indian mobile, one digit outside the reserved block.
    expect(isFakePhone(OUT_OF_RANGE_IN)).toBe(false);
    expect(isFakePhone(OUT_OF_RANGE_US)).toBe(false);
  });

  it('accepts the Indian fakes as structurally valid mobiles', () => {
    // They must pass the real validation rule, otherwise they cannot exercise the gate
    // steps that come after number validity.
    for (const number of Object.values(FAKE_IN)) {
      expect(INDIAN_MOBILE.test(number), number).toBe(true);
    }
  });

  it('keeps the invalid fixtures invalid', () => {
    expect(INDIAN_MOBILE.test(INVALID_PHONES.wrongIndianPrefix)).toBe(false);
    expect(INDIAN_MOBILE.test(INVALID_PHONES.tooShort)).toBe(false);
    expect(INDIAN_MOBILE.test(INVALID_PHONES.notE164)).toBe(false);
  });

  it('refuses to dial a number outside the reserved ranges', () => {
    expect(() => {
      assertFakePhone(FAKE_IN.customer);
    }).not.toThrow();
    expect(() => {
      assertFakePhone(OUT_OF_RANGE_IN);
    }).toThrow(/not in a reserved test range/);
  });

  it('does not leak the number it refused', () => {
    // The guard's own message must not become the PII leak it exists to prevent.
    try {
      assertFakePhone(OUT_OF_RANGE_IN);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(OUT_OF_RANGE_IN.slice(3));
    }
  });

  it('keeps the prefix list in sync with the linters', () => {
    // tools/eslint-plugin-naaradh/index.js and scripts/lint-pii.mjs hard-code these; read both
    // and compare, so the three can never drift apart. If this fails, update all three together.
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    for (const file of ['tools/eslint-plugin-naaradh/index.js', 'scripts/lint-pii.mjs']) {
      const src = readFileSync(`${root}${file}`, 'utf8');
      const list = /const FAKE_PREFIXES = \[([\s\S]*?)\];/.exec(src)?.[1] ?? '';
      const prefixes = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      expect(prefixes, file).toEqual([...FAKE_PHONE_PREFIXES]);
    }
    // Every prefix sits inside a reserved or conventional range (see the header comment).
    expect([...FAKE_PHONE_PREFIXES]).toEqual([
      '+916000000',
      '+121255501',
      '+180855501',
      '+190755501',
      '+190255501',
      '+447700900',
    ]);
  });
});
