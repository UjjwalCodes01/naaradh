/**
 * The only phone numbers allowed to appear in this repository.
 *
 * CLAUDE.md invariant 8: raw phone numbers never appear in logs, error messages, analytics
 * exports, or test fixtures committed to git. Every fixture, seed, doc example and test case
 * draws from here, and both `pnpm lint` (tools/eslint-plugin-naaradh) and `pnpm lint:pii`
 * (scripts/lint-pii.mjs) reject any number outside these prefixes.
 *
 * Honesty about what "reserved" means per region:
 *
 *   +1  212 555 0100-0199   GENUINELY RESERVED. NANP reserves line numbers 555-0100 to
 *                           555-0199 for fictitious use (any area code; 212 chosen here).
 *   +1  808/907/902 555 0100-0199  The same reserved lines in Hawaii, Alaska and Nova Scotia,
 *                           for the area-code time-zone hint (P6-CMP-1).
 *   +44 7700 900000-900999  GENUINELY RESERVED. Ofcom's drama range for UK mobiles.
 *   +91 6000 000 000-999    A CONVENTION OF THIS REPO, NOT a regulator-reserved range.
 *                           India has no published fictitious-number range (see Q-14 in
 *                           docs/open-questions.md). These numbers are valid under the
 *                           Indian mobile rule ^\+91[6-9]\d{9}$, which is exactly why they
 *                           are useful for testing the gate — and exactly why they must
 *                           never reach a dialler.
 *
 * The protection that actually matters is therefore NOT the choice of digits: it is that
 * ENGINE_DEFAULT_IN/US default to `simulator` outside production, and that the simulator
 * refuses to place a call to any number failing `isFakePhone()`. Keep that assertion in
 * place; do not weaken it to test "a realistic number".
 */

/** Prefixes mirrored in tools/eslint-plugin-naaradh/index.js and scripts/lint-pii.mjs. */
export const FAKE_PHONE_PREFIXES = [
  '+916000000',
  '+121255501',
  '+180855501',
  '+190755501',
  '+190255501',
  '+447700900',
] as const;

/** India (+91). Passes the Indian mobile regex; used for window, consent and CLI tests. */
export const FAKE_IN = {
  /** Default happy-path recipient. */
  customer: '+916000000001',
  /** Second recipient, for "multiple orders, same phone" merging (E-42). */
  customerAlt: '+916000000002',
  /** Already opted out; suppression must block even a new order (E-03). */
  optedOut: '+916000000010',
  /** On DND/NCPR; promotional must be gated, transactional depends on Q-02. */
  dnd: '+916000000011',
  /** Landline-typed number; gate step 4 must reject (E-27). */
  landline: '+916000000012',
  /** A minor answered previously; suppressed for 90 days (E-11). */
  minorAnswered: '+916000000013',
  /** Merchant's own phone, for the onboarding test call. */
  merchant: '+916000000100',
  /** Transfer target for warm-transfer tests (E-30). */
  transferTarget: '+916000000101',
} as const;

/** United States (+1). NANP fictitious range, for TCPA/two-party-recording tests. */
export const FAKE_US = {
  customer: '+12125550100',
  /** No written consent on file; marketing must be gated (E-07). */
  noWrittenConsent: '+12125550101',
  transferTarget: '+12125550190',
  /** Area code 808: Hawaii, outside the New York–Los Angeles intersection. */
  hawaii: '+18085550100',
  /** Area code 907: Alaska. */
  alaska: '+19075550100',
} as const;

/** Canada (+1). Area code 902, Nova Scotia — Atlantic time, east of Toronto. */
export const FAKE_CA = {
  halifax: '+19025550100',
} as const;

/** United Kingdom (+44). Ofcom drama range, for PECR/TPS tests. */
export const FAKE_UK = {
  customer: '+447700900001',
  transferTarget: '+447700900090',
} as const;

/**
 * Deliberately invalid, for negative tests on gate step 4 (E-26, E-27).
 *
 * These sit OUTSIDE the reserved ranges on purpose — that is what makes them useful — so
 * each one carries `naaradh-pii-allow` to tell the two PII linters it is intentional. None
 * of them is dialable: wrong prefix, too short, not E.164, a premium range, an emergency
 * short code.
 */
export const INVALID_PHONES = {
  /** Indian mobiles cannot start with 5. */
  wrongIndianPrefix: '+915000000001', // naaradh-pii-allow: invalid by construction, gate step 4 negative test
  tooShort: '+9160000',
  notE164: '6000000001', // naaradh-pii-allow: missing +, tests E.164 validation
  /** UK premium rate (090x) — must be refused outright. */
  premiumRate: '+449090000000', // naaradh-pii-allow: premium range, must never be dialable
  emergency: '112',
} as const;

export function isFakePhone(e164: string): boolean {
  return FAKE_PHONE_PREFIXES.some((prefix) => e164.startsWith(prefix));
}

/**
 * Guard for the simulator and any dev-mode dialler. Throwing here is the last line of
 * defence between a test run and a real person's phone ringing.
 */
export function assertFakePhone(e164: string): void {
  if (!isFakePhone(e164)) {
    throw new Error(
      `Refusing to dial ${e164.slice(0, 3)}*** : not in a reserved test range. ` +
        `Allowed prefixes: ${FAKE_PHONE_PREFIXES.join(', ')}. ` +
        `See shared/test/fake-phones.ts.`,
    );
  }
}
