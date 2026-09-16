/**
 * The words a shopper agrees to when they tick Naaradh's consent box (E-13, ADR-0010 §2). Every
 * version ever shown is kept here forever: the consent ledger stores the version, and a consent
 * is only as good as the text it points to. The checkout extension and the cart block show the
 * text of `CURRENT_CONSENT_WORDING` and write its version into the `naaradh_call_consent`
 * attribute; `packages/pipeline/test/consent-wording.test.ts` checks they agree.
 *
 * TODO_LEGAL (Q-08): drafts until counsel approves the wording per language. A draft version is
 * still recorded honestly — the ledger says exactly which draft the shopper saw.
 */
export interface ConsentWording {
  readonly version: string;
  readonly status: 'draft' | 'approved' | 'withdrawn';
  readonly text: Readonly<Record<'en-IN' | 'hi-IN', string>>;
  readonly publishedAt: string;
}

export const CONSENT_WORDINGS: Readonly<Record<string, ConsentWording>> = {
  '2026-09-v1-draft': {
    version: '2026-09-v1-draft',
    status: 'draft',
    publishedAt: '2026-09-15',
    text: {
      'en-IN':
        'Yes, {{store}} may call me (including automated calls), and send SMS or WhatsApp messages, about this order, my cart and offers. I can say "stop" or opt out at any time.',
      'hi-IN':
        'Haan, {{store}} mujhe is order, mere cart aur offers ke baare mein call (automated call bhi) kar sakta hai aur SMS ya WhatsApp bhej sakta hai. Main kabhi bhi "stop" bolkar mana kar sakta/sakti hoon.',
    },
  },
};

export const CURRENT_CONSENT_WORDING = '2026-09-v1-draft';

/** A version a shopper could actually have seen — anything else is not consent (E-106). */
export function isKnownConsentWording(version: string | null | undefined): version is string {
  if (version === null || version === undefined) return false;
  const w = CONSENT_WORDINGS[version];
  return w !== undefined && w.status !== 'withdrawn';
}
