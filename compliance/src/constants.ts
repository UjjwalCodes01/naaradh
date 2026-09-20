/**
 * Every regulatory and policy constant the gate depends on, in one place, each with its
 * source. AGENTS.md section 15 points here.
 *
 * Rules for editing this file:
 *
 *   - A value tagged VERIFIED came from a primary source. Do not change it without a new
 *     primary source cited in the PR.
 *   - A value tagged TODO_LEGAL is a conservative placeholder awaiting a lawyer or a
 *     regulator's final rules. It is deliberately stricter than it may need to be.
 *   - A value tagged OPEN depends on an unresolved question in docs/open-questions.md.
 *   - Changing a threshold that gates or bills requires an ADR in docs/decisions/
 *     (CLAUDE.md). The regression suite asserts these numbers, so a quiet edit fails CI —
 *     that is the intended behaviour, not an obstacle to work around.
 */

import type { Purpose, UseCaseKind } from './gate/types.js';

/** Purpose determines which consent and window rules apply. */
export const PURPOSES = [
  'transactional',
  'service',
  'promotional',
] as const satisfies readonly Purpose[];

/** Promotional purposes always require a consent row (invariant 5). */
export const PROMOTIONAL_USE_CASES = ['abandoned_cart', 'feedback', 'reactivation'] as const;

// ---------------------------------------------------------------------------
// Calling windows — always evaluated in the RECIPIENT's IANA zone (invariant 2).
// ---------------------------------------------------------------------------

export interface CallingWindow {
  readonly zone: string;
  /** Local time, 24h, inclusive. */
  readonly open: string;
  /** Local time, 24h, exclusive: a call may not START at or after this. */
  readonly close: string;
}

/** VERIFIED — TRAI TCCCPR 2018. Hard limit; invariant 3. */
export const WINDOW_IN: CallingWindow = {
  zone: 'Asia/Kolkata',
  open: '09:00',
  close: '21:00',
};

/**
 * A calling-window rule for one region and purpose (P6-CMP-1). Every non-Indian rule is
 * `[LEGAL]`: chosen as the conservative intersection of the rules we know of, pending the
 * TCPA / ePrivacy review (P6-LEG-1, P6-LEG-2, Q-29). Tightening one is always safe; loosening one
 * needs the review first.
 */
export interface WindowRule {
  /** Local-time segments, 24h: open inclusive, close exclusive. Most regions have one. */
  readonly segments: readonly { readonly open: string; readonly close: string }[];
  /** ISO weekdays allowed (1 = Monday … 7 = Sunday); null = every day. */
  readonly days: readonly number[] | null;
  /** Public holidays on which no call of this kind starts. */
  readonly holidays: 'US' | 'FR' | null;
}

const DAILY = null;
const MON_SAT = [1, 2, 3, 4, 5, 6] as const;
const MON_FRI = [1, 2, 3, 4, 5] as const;

/**
 * US. The federal rule is 08:00–21:00 local for telephone solicitations (47 CFR 64.1200(c)(1)).
 * Several states are stricter — 08:00–20:00 in Florida, Oklahoma and Washington among others —
 * and several ban solicitation calls on Sundays and legal holidays. 09:00–20:00, Monday to
 * Saturday, never on a federal holiday, satisfies all of those at once for marketing.
 * Service calls about the customer's own order or appointment keep 09:00–20:00 every day.
 */
const US_SERVICE: WindowRule = {
  segments: [{ open: '09:00', close: '20:00' }],
  days: DAILY,
  holidays: null,
};
const US_MARKETING: WindowRule = {
  segments: [{ open: '09:00', close: '20:00' }],
  days: MON_SAT,
  holidays: 'US',
};

/**
 * Canada. CRTC telemarketing rules: 09:00–21:30 on weekdays, 10:00–18:00 at weekends. Marketing
 * here keeps the US hours and drops the weekend rather than modelling a second set of hours.
 */
const CA_MARKETING: WindowRule = {
  segments: [{ open: '09:00', close: '20:00' }],
  days: MON_FRI,
  holidays: null,
};

/**
 * France. Décret n° 2022-1313: commercial prospecting calls only Monday to Friday, 10:00–13:00
 * and 14:00–20:00, never on a public holiday.
 */
const FR_MARKETING: WindowRule = {
  segments: [
    { open: '10:00', close: '13:00' },
    { open: '14:00', close: '20:00' },
  ],
  days: MON_FRI,
  holidays: 'FR',
};

/** Europe and the UK otherwise: 09:00–20:00, and no marketing on a Sunday. */
const EU_SERVICE: WindowRule = {
  segments: [{ open: '09:00', close: '20:00' }],
  days: DAILY,
  holidays: null,
};
const EU_MARKETING: WindowRule = {
  segments: [{ open: '09:00', close: '20:00' }],
  days: MON_SAT,
  holidays: null,
};

/** Kind of call → rule. `service` and `transactional` share hours; `promotional` is marketing. */
export interface RegionWindowRules {
  readonly transactional: WindowRule;
  readonly service: WindowRule;
  readonly promotional: WindowRule;
}

export const WINDOW_RULES_US: RegionWindowRules = {
  transactional: US_SERVICE,
  service: US_SERVICE,
  promotional: US_MARKETING,
};
export const WINDOW_RULES_CA: RegionWindowRules = {
  transactional: US_SERVICE,
  service: US_SERVICE,
  promotional: CA_MARKETING,
};
export const WINDOW_RULES_FR: RegionWindowRules = {
  transactional: EU_SERVICE,
  service: EU_SERVICE,
  promotional: FR_MARKETING,
};
export const WINDOW_RULES_EU: RegionWindowRules = {
  transactional: EU_SERVICE,
  service: EU_SERVICE,
  promotional: EU_MARKETING,
};

// ---------------------------------------------------------------------------
// Recording consent (P6-CMP-1, Q-12)
// ---------------------------------------------------------------------------

/**
 * How the recording is handled at the start of a call, by the RECIPIENT's region:
 *
 *   notice  the opening says the call is recorded (invariant 7); staying on the line after an
 *           unambiguous notice is consent where one party's consent suffices.
 *   ask     the opening also ASKS, and the call goes on only after a clear yes. Required where
 *           every party must agree: about a dozen US states (California, Florida, Illinois,
 *           Maryland, Massachusetts, Montana, Nevada, New Hampshire, Pennsylvania, Washington…),
 *           Germany (§201 StGB), Switzerland (Art. 179bis StGB) and Austria (§120 StGB).
 *
 * A US number does not reliably say which state its owner is in, so every US call asks.
 * `[LEGAL]` — P6-LEG-1, P6-LEG-2. Asking where notice would do costs a sentence; the reverse is
 * a criminal offence in some of these places.
 */
export type RecordingConsentMode = 'notice' | 'ask';

/**
 * P6-ENG-2 — recipient regions where the caller ID must carry STIR/SHAKEN A-attestation. US
 * (FCC TRACED Act) and Canadian (CRTC) carriers label or block calls with weaker attestation,
 * and an automated call labelled "Spam Likely" is both unanswered and complained about. The
 * number's attestation is recorded by a person from a test call or the carrier's report
 * (`numbers.attestation`); a number never checked is not used.
 */
export const ATTESTED_CLI_REGIONS: ReadonlySet<string> = new Set(['US', 'CA']);

const RECORDING_CONSENT_ASK = new Set(['US', 'DE', 'CH', 'AT']);

export function recordingConsentFor(region: string): RecordingConsentMode {
  return RECORDING_CONSENT_ASK.has(region) ? 'ask' : 'notice';
}

/**
 * Dial no later than this many minutes before window close, so a call that connects does
 * not run past 21:00 (E-01: an order at 20:50 is dialled by 20:55 or gated).
 */
export const WINDOW_CLOSE_BUFFER_MINUTES = 5;

// ---------------------------------------------------------------------------
// Consent and suppression
// ---------------------------------------------------------------------------

/**
 * VERIFIED — TRAI: a call is transactional only if placed within 30 minutes of the
 * customer-triggered event. Invariant 4: past this, a COD confirmation is NOT transactional
 * and must be gated with 'window:transactional_expired'. Never re-queued to next morning.
 */
export const TRANSACTIONAL_WINDOW_MINUTES = 30;

/** VERIFIED — explicit promotional consent is valid 7 days for a specific purpose (India). */
export const PROMOTIONAL_CONSENT_VALIDITY_DAYS_IN = 7;

/** VERIFIED — 90-day no-contact cooling period on that purpose after an opt-out (E-03). */
export const OPT_OUT_COOLING_DAYS = 90;

/** Suppression duration when a minor answered (E-11). Mirrors the opt-out period. */
export const MINOR_ANSWERED_SUPPRESSION_DAYS = 90;

/** OPEN (Q-02) — scrub everything until a TSP says in writing that transactional is exempt. */
export const DND_SCRUB_TRANSACTIONAL_DEFAULT = true;

/** A DND/NCPR scrub result may be reused for this long (invariant: fail closed on error). */
export const DND_SCRUB_CACHE_HOURS = 24;

// ---------------------------------------------------------------------------
// Complaints — E-05. The regulatory trigger is 5 valid complaints in a rolling 10-day
// window, which can blacklist all telecom resources across every TSP for up to a year.
// We pause a tenant well before that.
// ---------------------------------------------------------------------------

export const COMPLAINT_WINDOW_DAYS = 10;
/** Complaints against one tenant in the window before that tenant is auto-paused. */
export const COMPLAINT_TENANT_PAUSE_THRESHOLD = 3;
/** Complaints across all tenants in the window before the global kill switch trips. */
export const COMPLAINT_GLOBAL_KILL_THRESHOLD = 5;
/**
 * A complaint about a number is attributed to the tenant whose OUTBOUND call reached it most
 * recently within this many days. No such call → `unattributed` (a complaint about a call we
 * never made — spoofed CLI, another company — must not pause anyone).
 */
export const COMPLAINT_ATTRIBUTION_DAYS = 30;
/** Public /do-not-call: requests per phone hash per day, and per IP per hour. */
export const DNC_REQUESTS_PER_PHONE_PER_DAY = 3;
export const DNC_REQUESTS_PER_IP_PER_HOUR = 10;

// ---------------------------------------------------------------------------
// Attempts and retries
// ---------------------------------------------------------------------------

/** Per (phone_hash, purpose, external_ref). VERIFIED against TCCCPR practice. */
export const MAX_ATTEMPTS_PER_24H = 2;
export const MAX_ATTEMPTS_LIFETIME = 3;
/**
 * Minimum gap between attempts to the same number for the same purpose. Two hours for
 * service and promotional (AGENTS §5.2 step 9). Transactional is shorter BY DESIGN: the COD
 * envelope is 30 minutes (invariant 4), so a two-hour gap would make "max 2 per 24h" a dead
 * letter for the primary use case — AGENTS §5.5 expects a second attempt to fit "if the
 * first failed quickly". Ten minutes is long enough not to be harassing and short enough to
 * fit one retry after an early no-answer. DECISION; not a regulatory constant.
 */
export const MIN_MINUTES_BETWEEN_ATTEMPTS: Readonly<Record<Purpose, number>> = {
  transactional: 10,
  service: 120,
  promotional: 120,
};
export const MIN_HOURS_BETWEEN_ATTEMPTS = 2;

/**
 * ADR-0010: attempts per intent by use case, on top of the lifetime limit. A promotional call
 * is made once; a no-answer is not a reason to call a shopper again about the same cart.
 * DECISION, not a regulatory constant.
 */
export const MAX_ATTEMPTS_BY_USE_CASE: Readonly<Partial<Record<UseCaseKind, number>>> = {
  abandoned_cart: 1,
  feedback: 1,
  reactivation: 1,
};

/**
 * ADR-0010: at most one DIALLED promotional call per phone per tenant in this many days, across
 * every promotional use case and every cart/order. DECISION — deliberately stricter than the
 * 7-day consent validity it mirrors.
 */
export const PROMOTIONAL_COOLDOWN_DAYS = 7;

/** ADR-0010 §1: a checkout is abandoned after this long without an update. */
export const ABANDONED_CART_IDLE_MINUTES = 45;
/** ADR-0010 §1: a checkout older than this is never called (the intent's hard deadline). */
export const ABANDONED_CART_MAX_AGE_HOURS = 24;
/** ADR-0010 §9: last-touch attribution window, default and the most a merchant may set. */
export const ATTRIBUTION_WINDOW_HOURS_DEFAULT = 24;
export const ATTRIBUTION_WINDOW_HOURS_MAX = 72;
/** ADR-0010 §8: no A/B leader is named below this many answered calls per arm. */
export const AB_MIN_ANSWERED_PER_ARM = 100;
/** ADR-0010 §11 / P4-OPS-1: weekly QA sample of human-answered calls per tenant. */
export const QA_SAMPLE_RATE = 0.02;
export const QA_SAMPLE_MIN_PER_TENANT = 1;
export const QA_SAMPLE_MAX_PER_TENANT = 20;

// ---------------------------------------------------------------------------
// Per-use-case dispatch envelope. `notBefore` gives a merchant's other apps time to act;
// `notAfter` is the hard deadline after which the intent expires rather than being retried.
// ---------------------------------------------------------------------------

export interface UseCaseWindow {
  readonly purpose: Purpose;
  readonly notBeforeMinutes: number;
  readonly notAfterMinutes: number;
  readonly maxDurationSec: number;
}

export const USE_CASE_WINDOWS = {
  cod_confirm: {
    purpose: 'transactional',
    notBeforeMinutes: 2,
    notAfterMinutes: TRANSACTIONAL_WINDOW_MINUTES,
    maxDurationSec: 120,
  },
  abandoned_cart: {
    purpose: 'promotional',
    notBeforeMinutes: 45,
    notAfterMinutes: 24 * 60,
    maxDurationSec: 150,
  },
  lead_callback: {
    purpose: 'service',
    notBeforeMinutes: 1,
    notAfterMinutes: 2 * 60,
    maxDurationSec: 180,
  },
  /** ADR-0010 §7: relative to the delivery event — the day after, and no later than 3 days. */
  feedback: {
    purpose: 'promotional',
    notBeforeMinutes: 24 * 60,
    notAfterMinutes: 72 * 60,
    maxDurationSec: 150,
  },
  /** Relative to appointment_ts, not event_ts: -24h to -2h. Handled by the intents consumer. */
  appointment_confirm: {
    purpose: 'service',
    notBeforeMinutes: -24 * 60,
    notAfterMinutes: -2 * 60,
    maxDurationSec: 240,
  },
} as const satisfies Record<string, UseCaseWindow>;

/** Hard cap passed to the engine as maxDurationSec (E-32). Every use case must be listed. */
export const MAX_DURATION_SEC_BY_USE_CASE: Readonly<Record<UseCaseKind, number>> = {
  cod_confirm: 120,
  abandoned_cart: 150,
  appointment_confirm: 240,
  appointment_book: 240,
  lead_callback: 180,
  delivery_reschedule: 150,
  feedback: 150,
  reactivation: 150,
  inbound_support: 600,
};

// ---------------------------------------------------------------------------
// Billing and outcome policy
// ---------------------------------------------------------------------------

/**
 * E-60 / invariant 11. Fixed: changing this set requires a product decision recorded in
 * docs/decisions/, because it is what merchants are charged for and what the Terms define.
 */
export const BILLABLE_OUTCOMES = [
  'confirmed',
  'confirmed_with_changes',
  'cancelled',
  'rescheduled',
  'booked',
] as const;

/** E-25 — a pocket answer with less human speech than this is inconclusive, not billable. */
export const MIN_HUMAN_SPEECH_SEC = 5;

/** E-44 — never auto-cancel an order or auto-write an address below this confidence. */
export const AUTO_WRITE_CONFIDENCE_MIN = 0.9;

/** E-33 — alert when gross margin on a call falls below this. */
export const MARGIN_ALERT_FLOOR = 0.4;

// ---------------------------------------------------------------------------
// Operational safety
// ---------------------------------------------------------------------------

/** Invariant 12 — kill switches are read from Redis with a short TTL, never process memory. */
export const KILL_SWITCH_CACHE_TTL_SEC = 5;

/** E-28 — retire a CLI whose 7-day answer rate falls below this. */
export const CLI_MIN_ANSWER_RATE_7D = 0.25;

/** E-34 — recordings must be persisted to our own GCS bucket within this window. */
export const RECORDING_PERSIST_DEADLINE_MINUTES = 10;

/** E-48 — dispatch must stop within this many seconds of an uninstall. */
export const UNINSTALL_STOP_DISPATCH_SECONDS = 60;

// ---------------------------------------------------------------------------
// Retention — TODO_LEGAL (Q-06). DPDP final rules may change these.
// ---------------------------------------------------------------------------

/** Recordings and transcripts. Tenant-configurable within the min/max. */
export const RETENTION_RECORDINGS_DAYS_DEFAULT = 90;
export const RETENTION_RECORDINGS_DAYS_MIN = 30;
export const RETENTION_RECORDINGS_DAYS_MAX = 365;

/** TODO_LEGAL — consents, suppressions, audit log and billing ledger as legal record. */
export const RETENTION_LEGAL_RECORDS_DAYS = 3 * 365;

/** TODO_LEGAL — target for completing an erasure request. Shopify's own limit is 30 days. */
export const ERASURE_COMPLETION_TARGET_DAYS = 30;
/**
 * The order cache (ADR-0006) answers "where is my order" for recent orders only
 * (CALLER_ID_ORDER_LOOKBACK_DAYS = 90); rows older than this are tombstoned by the retention
 * job — data minimisation (Shopify Level 2, DPDP).
 */
export const ORDER_CACHE_RETENTION_DAYS = 180;
/**
 * ADR-0010: a checkout's phone link is only needed for the 24-hour recovery window and the
 * attribution window after it. DECISION (data minimisation) — rows keep their counts.
 */
export const CHECKOUT_RETENTION_DAYS = 30;
/**
 * ADR-0011: an appointment's phone link is needed until the appointment happens and for a
 * while after, so the support line can answer "did I come in?". Matches the order cache.
 * DECISION (data minimisation) — the time and the service stay; the person does not.
 */
export const APPOINTMENT_RETENTION_DAYS = 180;

/** A self-service do-not-call submission becomes a global suppression within this long. */
export const DNC_PAGE_PROCESSING_HOURS = 24;

// ---------------------------------------------------------------------------
// Inbound (ADR-0006, AGENTS §5.7–§5.9)
// ---------------------------------------------------------------------------

/** p95 budgets. A mid-call tool slower than this is dead air the caller notices (E-93). */
export const INBOUND_CONTEXT_BUDGET_MS = 500;
export const INBOUND_TOOL_BUDGET_MS = 700;

/** E-94 — failed verify_caller attempts before verification is locked for the call. */
export const VERIFY_MAX_FAILURES = 3;

/** E-84 — the cancellation confirmation token is single-use and short-lived. */
export const CANCEL_TOKEN_TTL_SEC = 300;

/** Safety cap when a profile sets none: forwards to the merchant past it (E-92). */
export const INBOUND_DEFAULT_MONTHLY_MINUTE_CAP = 10_000;

/** How far back caller ID matches orders for identity and lookups. */
export const CALLER_ID_ORDER_LOOKBACK_DAYS = 90;
export const LOOKUP_MAX_ORDERS = 3;

export const KNOWLEDGE_MAX_RESULTS = 3;
export const KNOWLEDGE_SNIPPET_MAX_CHARS = 600;

/** Inbound minutes are metered per call, rounded UP (Q-04 pessimistic until invoices say otherwise). */
export const INBOUND_BILLING_ROUNDING_SEC = 60;
