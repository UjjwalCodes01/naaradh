import { addDays } from '@naaradh/shared';
import { PROMOTIONAL_CONSENT_VALIDITY_DAYS_IN } from './constants.js';
import type { ConsentSource, Purpose } from './gate/types.js';

/**
 * Consent policy by RECIPIENT region (invariant 2, E-07). Two questions:
 *
 *   which sources are acceptable for this purpose in this region?
 *   how long does a consent captured this way last?
 *
 * The answers are pure data so the regression suite can pin them. `'not_required'` means the
 * purpose is covered by the transaction itself (TRAI implicit consent for the contract
 * duration; FCC prior express consent by providing the number in the transaction) — the
 * 30-minute rule for transactional purposes is enforced separately by the gate.
 */

type RegionRules = Readonly<Record<Purpose, ReadonlySet<ConsentSource> | 'not_required'>>;

/** Sources that are never sufficient anywhere: a bought list (E-71) and a bare assertion (E-08). */
const NEVER: ReadonlySet<ConsentSource> = new Set(['import', 'attestation']);

const OPT_IN: ReadonlySet<ConsentSource> = new Set([
  'checkout',
  'checkout_written',
  'form',
  'form_written',
  'api',
  'verbal',
  'dca',
]);
const WRITTEN: ReadonlySet<ConsentSource> = new Set(['checkout_written', 'form_written']);

const INDIA: RegionRules = {
  transactional: 'not_required',
  service: OPT_IN,
  promotional: OPT_IN,
};

const US: RegionRules = {
  transactional: 'not_required',
  service: OPT_IN,
  // TCPA: prior express WRITTEN consent for marketing with an artificial voice.
  promotional: WRITTEN,
};

/** ePrivacy Art. 13(3): opt-in for every automated call. Design assumption per SPEC §4.3. */
const EU: RegionRules = {
  transactional: OPT_IN,
  service: OPT_IN,
  promotional: OPT_IN,
};

const EU_REGIONS = new Set([
  'GB',
  'IE',
  'DE',
  'FR',
  'ES',
  'IT',
  'NL',
  'BE',
  'AT',
  'CH',
  'PT',
  'SE',
  'DK',
  'NO',
  'FI',
  'PL',
]);

export function consentRulesFor(region: string): RegionRules {
  if (region === 'IN') return INDIA;
  if (region === 'US' || region === 'CA') return US;
  if (EU_REGIONS.has(region)) return EU;
  // Unknown region: the strictest rule set we have.
  return EU;
}

export type ConsentRequirement =
  | { required: false }
  | { required: true; acceptableSources: ReadonlySet<ConsentSource> };

export function consentRequirement(region: string, purpose: Purpose): ConsentRequirement {
  const rule = consentRulesFor(region)[purpose];
  if (rule === 'not_required') return { required: false };
  return { required: true, acceptableSources: rule };
}

export function isSourceAcceptable(
  region: string,
  purpose: Purpose,
  source: ConsentSource,
): boolean {
  if (NEVER.has(source)) return false;
  const req = consentRequirement(region, purpose);
  return req.required ? req.acceptableSources.has(source) : true;
}

/**
 * When a consent captured at `capturedAt` stops being valid. India: explicit consent is
 * valid 7 days for a specific purpose (VERIFIED). US written and EU opt-in: until withdrawn.
 * Computed once at recordConsent() time and stored as `expires_at`; the gate only compares.
 */
export function consentExpiresAt(region: string, purpose: Purpose, capturedAt: Date): Date | null {
  if (region === 'IN' && purpose !== 'transactional')
    return addDays(capturedAt, PROMOTIONAL_CONSENT_VALIDITY_DAYS_IN);
  return null;
}
