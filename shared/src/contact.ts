/**
 * The public mailboxes, in one place.
 *
 * Every one of these is `info@naaradh.com` today, because that is the mailbox that exists. Role
 * addresses read better and we will want them, but an address that bounces is worse than a plain
 * one: a DPDP grievance, a do-not-call request and a vulnerability report all have to arrive, and
 * two of those are answers we owe by law.
 *
 * The roles are kept apart anyway, so the transition costs one line each: when `privacy@` is a
 * real alias, change it here and the contact page, the privacy policy, the grievance page and
 * security.txt all follow. Anything shown to a merchant or a customer reads from here — never a
 * literal in a page.
 */
export const MAIL = {
  support: 'info@naaradh.com',
  sales: 'info@naaradh.com',
  billing: 'info@naaradh.com',
  /** Privacy, grievances and erasure requests (DPDP grievance officer). */
  privacy: 'info@naaradh.com',
  /** Do-not-call requests that arrive by email rather than through the form. */
  dnc: 'info@naaradh.com',
  /** Vulnerability reports; also the `Contact:` line in `.well-known/security.txt`. */
  security: 'info@naaradh.com',
  legal: 'info@naaradh.com',
} as const;
