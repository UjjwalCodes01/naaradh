/**
 * Every reason the gate can refuse a call, with the plain-language explanation and the
 * "what to do" hint the dashboard shows (AGENTS §5.2). Machine code on the left is what is
 * stored in `call_intents.gated_reason`; adding one here is the only way to add one.
 *
 * `temporary` tells the dispatcher whether a `retryAt` makes sense at all.
 */
export interface GateReasonInfo {
  readonly title: string;
  readonly explanation: string;
  readonly hint: string;
  readonly temporary: boolean;
}

export const GATE_REASONS = {
  // step 0 — intent sanity
  'intent:too_early': {
    title: 'Not yet due',
    explanation: 'The call was evaluated before its earliest allowed time.',
    hint: 'Nothing to do; it will be re-evaluated at the scheduled time.',
    temporary: true,
  },
  'intent:expired': {
    title: 'Deadline passed',
    explanation: 'The latest allowed time for this call has passed.',
    hint: 'No call will be made. Trigger a new request if the customer still needs one.',
    temporary: false,
  },
  'intent:inbound': {
    title: 'Not an outbound intent',
    explanation: 'Inbound calls are not scheduled through the outbound gate.',
    hint: 'None.',
    temporary: false,
  },
  'engine:unroutable': {
    title: 'No engine for this region',
    explanation: "Naaradh has no voice engine configured for the recipient's country.",
    hint: "This number's country is not yet supported.",
    temporary: false,
  },
  'engine:circuit_open': {
    title: 'Voice engine unavailable',
    explanation: 'The voice engine is failing and calls are being held (E-20).',
    hint: 'Calls resume automatically when the engine recovers. Check status.naaradh.com.',
    temporary: true,
  },

  // step 1 — tenant + billing
  'tenant:inactive': {
    title: 'Account paused',
    explanation: 'Your account is paused or suspended, so no calls are placed.',
    hint: 'See the banner at the top of your dashboard for the cause and next step.',
    temporary: true,
  },
  'tenant:pending_review_promotional': {
    title: 'Account under review',
    explanation:
      'Promotional calls are disabled while a new account is in its 7-day review window (E-73).',
    hint: 'Transactional calls continue. Promotional calls start automatically after review.',
    temporary: true,
  },
  'tenant:other_region': {
    title: 'Account belongs to another region',
    explanation:
      "This account's data lives in another region, and calls are always placed by the deployment that holds it (ADR-0012). Nothing was dialled here.",
    hint: 'If you are seeing this in production, a request reached the wrong region: check the routing before anything else.',
    temporary: false,
  },
  'tenant:promotional_paused': {
    title: 'Promotional calls paused',
    explanation:
      'A complaint was received about a promotional call, so promotional calling is paused for your account while Naaradh reviews it (ADR-0010).',
    hint: 'Order confirmations and other service calls continue. Naaradh support will contact you.',
    temporary: false,
  },
  'billing:not_set_up': {
    title: 'Billing not set up',
    explanation: 'No active plan is attached to this account.',
    hint: 'Choose a plan under Settings → Billing.',
    temporary: true,
  },
  'billing:frozen': {
    title: 'Payment failed',
    explanation:
      'Your subscription payment was declined and the 3-day grace period has ended (E-50).',
    hint: 'Update your payment method under Settings → Billing.',
    temporary: true,
  },
  'billing:capped': {
    title: 'Spend cap reached',
    explanation: 'Usage charges have reached the cap you approved (E-61).',
    hint: 'Raise the cap under Settings → Billing to resume calls.',
    temporary: true,
  },
  'billing:cancelled': {
    title: 'Subscription cancelled',
    explanation: 'The subscription for this account was cancelled.',
    hint: 'Choose a plan under Settings → Billing.',
    temporary: true,
  },

  // step 2 — kill switches
  'kill:global': {
    title: 'Calling paused platform-wide',
    explanation: 'Naaradh has paused all outbound calling.',
    hint: 'See status.naaradh.com.',
    temporary: true,
  },
  'kill:engine': {
    title: 'Engine paused',
    explanation: 'Calling through this voice engine is paused.',
    hint: 'See status.naaradh.com.',
    temporary: true,
  },
  'kill:tenant': {
    title: 'Calling paused for your account',
    explanation: 'Outbound calling is paused for your account.',
    hint: 'See the banner on your dashboard.',
    temporary: true,
  },
  'kill:campaign': {
    title: 'Campaign stopped',
    explanation: 'This campaign has been stopped.',
    hint: 'Resume the campaign to continue.',
    temporary: true,
  },

  // step 3 — spend caps
  'cap:tenant_daily': {
    title: 'Daily spend cap reached',
    explanation: "Today's calls have reached your daily spend cap (E-32).",
    hint: 'Raise the cap under Settings, or wait for tomorrow.',
    temporary: true,
  },
  'cap:tenant_monthly': {
    title: 'Monthly spend cap reached',
    explanation: "This month's calls have reached your monthly spend cap (E-32).",
    hint: 'Raise the cap under Settings.',
    temporary: true,
  },
  'cap:engine_daily': {
    title: 'Engine daily cap reached',
    explanation: "Naaradh's daily safety cap for this engine was reached.",
    hint: 'Calls resume tomorrow. Contact support if this recurs.',
    temporary: true,
  },
  'cap:global_daily': {
    title: 'Platform daily cap reached',
    explanation: "Naaradh's platform-wide daily safety cap was reached.",
    hint: 'Calls resume tomorrow.',
    temporary: true,
  },

  // step 4 — number and contact
  'number:missing': {
    title: 'No phone number',
    explanation: 'The order has no phone number, so there is nothing to call (E-43).',
    hint: 'Enable the phone field at checkout.',
    temporary: false,
  },
  'number:invalid': {
    title: 'Invalid phone number',
    explanation: 'The number is not a valid mobile number for its country (E-26).',
    hint: 'Confirm the order another way; consider validating phone numbers at checkout.',
    temporary: false,
  },
  'number:landline': {
    title: 'Landline number',
    explanation: 'The number is a landline; automated calls are placed to mobiles only (E-27).',
    hint: 'Confirm the order another way.',
    temporary: false,
  },
  'number:type_unknown': {
    title: 'Number type unknown',
    explanation: 'We could not confirm the number is a mobile.',
    hint: 'It will be retried once the lookup succeeds.',
    temporary: true,
  },
  'contact:skip': {
    title: 'Marked as test/staff',
    explanation: 'This contact is tagged as a test or staff contact and is never called (E-46).',
    hint: 'Remove the tag to allow calls.',
    temporary: false,
  },
  'contact:erased': {
    title: 'Data erased',
    explanation: 'This person requested erasure of their data; we hold no number to call.',
    hint: 'None.',
    temporary: false,
  },

  // step 5 — suppressions
  'suppression:global': {
    title: 'On the do-not-call list',
    explanation:
      'This number asked not to be called by any business using Naaradh, or is protected (minor answered, complaint).',
    hint: 'Do not contact this number by phone.',
    temporary: false,
  },
  'suppression:tenant': {
    title: 'Opted out',
    explanation:
      'This customer asked your business not to call them for this purpose (E-03, 90 days).',
    hint: 'Respect the opt-out. Contact them another way if needed.',
    temporary: false,
  },

  // step 6 — consent
  'window:transactional_expired': {
    title: 'Confirmation window passed',
    explanation:
      'More than 30 minutes have passed since the order, so an automated confirmation call is no longer permitted as a transactional call (invariant 4).',
    hint: 'Confirm this order manually or by message. Orders placed after 20:30 IST will usually land here.',
    temporary: false,
  },
  'consent:missing': {
    title: 'No consent on record',
    explanation:
      "This kind of call needs the customer's explicit consent and none is on record (invariant 5).",
    hint: 'Enable the consent checkbox at checkout; calls resume for customers who tick it.',
    temporary: false,
  },
  'consent:expired': {
    title: 'Consent expired',
    explanation: "The customer's consent is older than the 7 days it is valid for.",
    hint: 'A new consent is needed before calling.',
    temporary: false,
  },
  'consent:source_insufficient': {
    title: 'Consent not strong enough',
    explanation:
      "The consent on record is not of the kind this call requires in the recipient's country (E-07, E-08).",
    hint: 'Marketing calls to US numbers need written consent; an attestation is never sufficient.',
    temporary: false,
  },
  'consent:dlt_not_linked': {
    title: 'DLT registration incomplete',
    explanation:
      'Promotional calls in India require your business to be registered as a Principal Entity on DLT and linked to Naaradh (E-06).',
    hint: 'Complete the DLT step under Settings → Compliance.',
    temporary: true,
  },

  // step 7 — window
  'window:closed_transactional': {
    title: 'Outside calling hours',
    explanation:
      "Calls are permitted 09:00–21:00 in the customer's local time, and this order cannot be confirmed within the transactional window before the next opening (E-01/E-02).",
    hint: 'Confirm this order manually or by message.',
    temporary: false,
  },
  'window:closed': {
    title: 'Outside calling hours',
    explanation: "Calls are permitted only during daytime hours in the customer's local time.",
    hint: 'The call is scheduled for the next opening.',
    temporary: true,
  },
  'window:unknown_region': {
    title: 'Calling hours unknown',
    explanation: "We do not know the permitted calling hours for this number's country.",
    hint: 'This country is not yet supported.',
    temporary: false,
  },

  // step 8 — DND
  'dnd:registered': {
    title: 'Number on DND',
    explanation: 'This number is on the national Do-Not-Disturb registry (E-04).',
    hint: 'Contact the customer another way.',
    temporary: false,
  },
  'dnd:unknown': {
    title: 'DND check unavailable',
    explanation:
      'The DND registry could not be checked, and promotional calls are never placed without a check.',
    hint: 'It will be retried automatically.',
    temporary: true,
  },

  // step 9 — attempts
  'attempts:daily': {
    title: 'Attempt limit reached today',
    explanation: 'This number was already called twice in the last 24 hours for this purpose.',
    hint: 'None; the limit protects the customer.',
    temporary: true,
  },
  'attempts:lifetime': {
    title: 'Attempt limit reached',
    explanation: 'This number was already called three times for this order.',
    hint: 'Confirm this order another way.',
    temporary: false,
  },
  'attempts:promotional_cooldown': {
    title: 'Called recently',
    explanation:
      'This customer received a promotional call from you in the last 7 days; Naaradh places at most one per week (ADR-0010).',
    hint: 'None; the limit protects the customer and your number from spam reports.',
    temporary: false,
  },
  'attempts:too_soon': {
    title: 'Too soon after the last call',
    explanation: 'A minimum gap is kept between calls to the same number.',
    hint: 'It will be retried after the gap.',
    temporary: true,
  },

  // step 10 — concurrency
  'concurrency:tenant': {
    title: 'All lines busy',
    explanation: "Your account's concurrent-call limit is in use (E-29).",
    hint: 'The call is queued and will go out shortly.',
    temporary: true,
  },
  'concurrency:engine': {
    title: 'Engine at capacity',
    explanation: 'The voice engine is at its concurrency limit.',
    hint: 'The call is queued and will go out shortly.',
    temporary: true,
  },

  // step 11 — CLI
  'cli:none_available': {
    title: 'No calling number available',
    explanation:
      'No caller-ID number is provisioned for this country and purpose, or all are retired (E-28, Q-01).',
    hint: 'Contact support.',
    temporary: true,
  },

  // step 12 — script
  'script:none_approved': {
    title: 'Script not approved',
    explanation: "There is no approved script for this use case in the customer's language.",
    hint: 'Approve a script under Settings → Scripts.',
    temporary: true,
  },
  'script:dlt_template_missing': {
    title: 'DLT template missing',
    explanation:
      'Promotional calls in India must run under a content template registered on the DLT portal, and the approved script has no template ID.',
    hint: 'Register the script wording on the DLT portal and add the template ID to the script.',
    temporary: false,
  },
} as const satisfies Record<string, GateReasonInfo>;

export type GateReason = keyof typeof GATE_REASONS;

export function reasonInfo(reason: GateReason): GateReasonInfo {
  return GATE_REASONS[reason];
}
