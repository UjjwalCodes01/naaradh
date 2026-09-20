/**
 * The phone-number fixtures: the only numbers allowed to appear in this repository.
 *
 * The prefixes and the dial guard live in `shared/src/fake-phones.ts` and are re-exported
 * here, so a test needs one import. They are in `src/` because the simulator engine calls
 * `assertFakePhone()` at dial time, and `.dockerignore` keeps `test/` out of every image.
 * Read that file first: it explains, per region, how reserved each range actually is.
 *
 * CLAUDE.md invariant 8: every fixture, seed, doc example and test case draws from here, and
 * both `pnpm lint` (tools/eslint-plugin-naaradh) and `pnpm lint:pii` (scripts/lint-pii.mjs)
 * reject any number outside these prefixes.
 */

export { FAKE_PHONE_PREFIXES, assertFakePhone, isFakePhone } from '../src/fake-phones.js';

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
