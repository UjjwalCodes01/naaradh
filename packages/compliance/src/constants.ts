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

/** VERIFY — FCC baseline is 8am-9pm local; several states are stricter. */
export const WINDOW_US_DEFAULT: CallingWindow = {
  zone: 'America/New_York',
  open: '08:00',
  close: '21:00',
};

/** VERIFY — member-state variation is wide; 09:00-20:00 is the conservative intersection. */
export const WINDOW_EU_DEFAULT: CallingWindow = {
  zone: 'Europe/Berlin',
  open: '09:00',
  close: '20:00',
};

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
