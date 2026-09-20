/**
 * The reserved test ranges, and the guard that refuses to dial anything outside them.
 *
 * This lives in `src/`, not in `test/`, because the simulator engine calls `assertFakePhone()`
 * at dial time — it is shipped, running code, the last line of defence between a stage
 * deployment and a real person's phone ringing. `.dockerignore` strips every `test/` directory
 * from the image build context, so a guard imported from there would not exist in the image
 * (and `scripts/check-docker-context.mjs` now fails the build if any service imports one).
 *
 * The fixtures themselves — the individual numbers each test and the seed use — stay in
 * `shared/test/fake-phones.ts`, which re-exports everything here.
 *
 * CLAUDE.md invariant 8: raw phone numbers never appear in logs, error messages, analytics
 * exports, or test fixtures committed to git. Every fixture, seed, doc example and test case
 * draws from these prefixes, and both `pnpm lint` (tools/eslint-plugin-naaradh) and
 * `pnpm lint:pii` (scripts/lint-pii.mjs) reject any number outside them.
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
        `See shared/src/fake-phones.ts.`,
    );
  }
}
