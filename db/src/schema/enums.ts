import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Postgres enums. AGENTS.md §4: adding a value is a migration, plus an ADR if it affects
 * billing or gating. Values are ordered as they appear in the lifecycle where one exists.
 */

export const tenantStatus = pgEnum('tenant_status', [
  /** E-73 — new tenants are reviewed for 7 days; dispatch limited, promotional blocked. */
  'pending_review',
  'active',
  /** Set by billing freeze (E-50), capped subscription (E-61), complaints (E-05), uninstall (E-48). */
  'paused',
  /** Manual: AUP violation (E-71). Only staff can lift. */
  'suspended',
  'uninstalled',
]);

export const dataRegion = pgEnum('data_region', ['in', 'us', 'eu']);

export const userRole = pgEnum('user_role', ['viewer', 'operator', 'manager', 'owner']);

export const integrationKind = pgEnum('integration_kind', [
  'shopify',
  'woocommerce',
  'api',
  'zoho',
  'hubspot',
  'calcom',
  'gcal',
  'gokwik',
  'shiprocket',
  'razorpay_magic',
  'cashfree',
]);

export const integrationStatus = pgEnum('integration_status', ['active', 'uninstalled', 'revoked']);

export const useCaseKind = pgEnum('use_case_kind', [
  'cod_confirm',
  'abandoned_cart',
  'appointment_confirm',
  'appointment_book',
  'lead_callback',
  'delivery_reschedule',
  'feedback',
  'reactivation',
  /** Customer-initiated calls answered by the agent (ADR pending; Q-15). */
  'inbound_support',
]);

/** SPEC §4.1.1 — decides consent, window and DND rules. */
export const purpose = pgEnum('purpose', ['transactional', 'service', 'promotional']);

/** Consent and suppression can be scoped to one purpose or to everything. */
export const purposeScope = pgEnum('purpose_scope', [
  'transactional',
  'service',
  'promotional',
  'all',
]);

export const callDirection = pgEnum('call_direction', ['outbound', 'inbound']);

export const numberSeries = pgEnum('number_series', ['140', '1600', '10digit', 'intl']);

export const numberStatus = pgEnum('number_status', ['warming', 'active', 'retired', 'suspended']);

export const phoneType = pgEnum('phone_type', ['mobile', 'landline', 'voip', 'unknown']);

export const consentSource = pgEnum('consent_source', [
  'checkout',
  /** US: prior express WRITTEN consent for marketing (TCPA). */
  'checkout_written',
  'form',
  'form_written',
  'api',
  'import',
  'verbal',
  /** Placeholder until Q-03 is answered. */
  'dca',
  /** E-08 — merchant attestation without evidence; never sufficient for promotional. */
  'attestation',
]);

export const consentAction = pgEnum('consent_action', ['grant', 'revoke']);

export const suppressionReason = pgEnum('suppression_reason', [
  'opt_out',
  'complaint',
  'dnd',
  'invalid',
  'manual',
  'minor',
  'wrong_number',
  'recording_refused',
  /** Public /do-not-call page (universal rule 8). */
  'self_service',
  'erasure',
]);

export const intentSource = pgEnum('intent_source', [
  'shopify',
  'woocommerce',
  'api',
  'gokwik',
  'shiprocket',
  'razorpay_magic',
  'cashfree',
  'zoho',
  'hubspot',
  'calcom',
  'gcal',
  'reconcile',
  'inbound',
]);

/** SPEC §11 — intent-level lifecycle. */
export const intentStatus = pgEnum('intent_status', [
  'CREATED',
  'SCHEDULED',
  'GATED',
  'DISPATCHING',
  'IN_PROGRESS',
  'RETRY_SCHEDULED',
  'COMPLETED',
  'EXHAUSTED',
  'EXPIRED',
  'CANCELLED',
]);

/** SPEC §11 — attempt-level lifecycle. */
export const attemptStatus = pgEnum('attempt_status', [
  'DISPATCHING',
  /** Engine returned an id but the HTTP call timed out; poll before retrying (AGENTS §5.3). */
  'UNCERTAIN',
  'DIALING',
  'RINGING',
  'IN_CONVERSATION',
  'TRANSFERRING',
  'ENDED',
  'NO_ANSWER',
  'BUSY',
  'AMD_HANGUP',
  'AMD_MESSAGE_LEFT',
  'FAILED',
  'CANCELLED',
]);

export const answeredBy = pgEnum('answered_by', ['human', 'machine', 'unknown']);

export const amdMode = pgEnum('amd_mode', ['hangup', 'leave_message', 'continue']);

/**
 * SPEC §6.5 v1.1. The billable set is fixed by E-60 / invariant 11 and pinned by
 * compliance constants + regression suite. Adding a NON-billable value is a plain
 * migration; touching the billable five is an ADR.
 */
export const outcome = pgEnum('outcome', [
  // billable
  'confirmed',
  'confirmed_with_changes',
  'cancelled',
  'rescheduled',
  'booked',
  // no human / no definitive result
  'no_answer',
  'busy',
  'voicemail',
  'no_response',
  'inconclusive',
  'failed',
  // wrong or protected recipient
  'wrong_number',
  'minor_answered',
  'opt_out',
  'recording_refused',
  // handed off or overtaken
  'transferred',
  'transfer_failed',
  'callback_requested',
  'needs_merchant_action',
  'convert_to_prepaid_requested',
  'outcome_superseded',
  // inbound (ADR-0006) — never outcome-billed; inbound is billed per minute
  'resolved',
  'ticket_created',
  'abandoned',
  'spam',
  // promotional + service (ADR-0010) — never billable (invariant 11 is unchanged)
  'will_complete',
  'will_buy_later',
  'not_interested',
  'price_objection',
  'qualified',
  'feedback_given',
]);

/** ADR-0010: an abandoned checkout's life in the cache, from arrival to its one call or none. */
export const checkoutStatus = pgEnum('checkout_status', [
  /** Waiting: still being edited, or idle less than 45 minutes. */
  'open',
  /** The abandoned-cart intent exists (see intent_id). */
  'scheduled',
  /** Never called; `skip_reason` says why. */
  'skipped',
  /** Shopify marked the checkout completed. */
  'completed',
  /** An order from the same phone (or this checkout) arrived. */
  'converted',
  /** Older than 24 h without being swept. */
  'expired',
]);

export const qaReviewStatus = pgEnum('qa_review_status', ['pending', 'done', 'skipped']);

export const extractionMethod = pgEnum('extraction_method', ['engine', 'llm', 'manual']);

export const writebackStatus = pgEnum('writeback_status', [
  'pending',
  'done',
  'failed',
  'skipped',
  /** E-44 — address/cancel suggestion parked for a human because confidence < 0.9. */
  'needs_review',
]);

export const transferResult = pgEnum('transfer_result', [
  'completed',
  'no_answer',
  'busy',
  'failed',
  'rejected',
]);

export const disputeStatus = pgEnum('dispute_status', ['open', 'accepted', 'rejected']);

export const campaignStatus = pgEnum('campaign_status', [
  'draft',
  'running',
  'paused',
  'completed',
  'stopped',
]);

export const complaintSource = pgEnum('complaint_source', [
  'trai',
  'merchant',
  'self_service',
  'vendor',
  'internal',
]);

export const complaintStatus = pgEnum('complaint_status', ['received', 'valid', 'invalid']);

/** complaint_reports lifecycle: `unattributed` = no call from any tenant to that number in the window. */
export const complaintReportStatus = pgEnum('complaint_report_status', [
  'pending',
  'recorded',
  'unattributed',
]);

export const billingKind = pgEnum('billing_kind', [
  'platform_fee',
  'outcome',
  'minute',
  'credit',
  'refund',
]);

/**
 * STIR/SHAKEN attestation the originating carrier gives a number's calls (P6-ENG-2). A: the
 * carrier knows the customer AND that they may use this number. B: knows the customer only.
 * C: neither. Unattested US calls are widely labelled "Spam Likely" or blocked outright.
 */
export const stirShakenAttestation = pgEnum('stir_shaken_attestation', ['A', 'B', 'C']);

/** What the edge routes on (ADR-0012 §4): a shop domain or one of our own phone numbers. */
export const directoryKind = pgEnum('directory_kind', ['shop', 'number']);

export const billingProvider = pgEnum('billing_provider', [
  'shopify',
  'razorpay',
  'stripe',
  'manual',
]);

/** A provider subscription as Naaradh last FETCHED it (ADR-0008 — webhooks are hints). */
export const billingSubscriptionStatus = pgEnum('billing_subscription_status', [
  'pending',
  'active',
  'frozen',
  'cancelled',
  'declined',
  'expired',
]);

export const billingPostingKind = pgEnum('billing_posting_kind', ['usage_record', 'addon']);

export const billingPostingStatus = pgEnum('billing_posting_status', [
  'pending',
  'posted',
  /** E-61 — the provider refused: over the subscription's capped amount. */
  'capped',
  'failed',
  /** Nothing to post (manual provider, zero amount). */
  'skipped',
]);

export const billingStatus = pgEnum('billing_status', [
  'none',
  'active',
  /** E-50 — declined/frozen; 3-day grace then paused. */
  'frozen',
  /** E-61 — Shopify cappedAmount reached. */
  'capped',
  'cancelled',
]);

export const actorType = pgEnum('actor_type', [
  'user',
  'api_key',
  'worker',
  'system',
  'shopify',
  'engine',
  /** A tool call made by the voice agent on a live call (ADR-0006). */
  'agent',
]);

export const webhookSource = pgEnum('webhook_source', [
  'shopify',
  'woocommerce',
  'engine_bolna',
  'engine_omnidim',
  'engine_retell',
  'engine_simulator',
  'razorpay',
  'stripe',
  'gokwik',
  'shiprocket',
  'razorpay_magic',
  'cashfree',
  /** CRM lead webhooks (P5-CRM-1/2): a workflow in the merchant's CRM posts a new lead. */
  'zoho',
  'hubspot',
]);

export const webhookEventStatus = pgEnum('webhook_event_status', [
  'received',
  'published',
  'processed',
  'failed',
  'duplicate',
  /** Signature failed — recorded for abuse monitoring, body NOT stored. */
  'rejected',
]);

export const deliveryStatus = pgEnum('delivery_status', ['pending', 'delivered', 'failed', 'dead']);

export const erasureSource = pgEnum('erasure_source', [
  'api',
  'dashboard',
  'call',
  'shopify_redact',
  'email',
  'dnc_page',
]);

export const erasureStatus = pgEnum('erasure_status', [
  'requested',
  'in_progress',
  'completed',
  'failed',
]);

export const killSwitchScope = pgEnum('kill_switch_scope', [
  'global',
  'engine',
  'tenant',
  'campaign',
  /** Inbound answering: key '*' = every tenant, or a tenant id (ADR-0006). */
  'inbound',
]);

export const apiKeyKind = pgEnum('api_key_kind', ['secret', 'public']);

export const scriptStatus = pgEnum('script_status', ['draft', 'approved', 'retired']);

/** ADR-0011 — appointments. `manual` is a merchant with no connected calendar. */
export const calendarProvider = pgEnum('calendar_provider', ['calcom', 'google', 'manual']);
export const calendarStatus = pgEnum('calendar_status', ['active', 'disabled', 'error']);
export const appointmentStatus = pgEnum('appointment_status', [
  'scheduled',
  'confirmed',
  'rescheduled',
  'cancelled',
  'completed',
  'no_show',
]);

export const dndResult = pgEnum('dnd_result', ['registered', 'not_registered', 'unknown']);

// ---------------------------------------------------------------------------------------------
// Inbound (ADR-0006)
// ---------------------------------------------------------------------------------------------

/** AGENTS §5.8 — what the caller has proven, ordered weakest to strongest. */
export const callerVerification = pgEnum('caller_verification', ['none', 'caller_id', 'knowledge']);

export const profileStatus = pgEnum('profile_status', ['draft', 'active', 'disabled']);

export const knowledgeStatus = pgEnum('knowledge_status', ['draft', 'published', 'archived']);

export const orderSource = pgEnum('order_source', ['shopify', 'woocommerce', 'api']);

export const paymentKind = pgEnum('payment_kind', ['cod', 'prepaid', 'unknown']);

export const ticketCategory = pgEnum('ticket_category', [
  'order_status',
  'cancellation',
  'address_change',
  'refund',
  'return',
  'delivery',
  'product',
  'complaint',
  'callback',
  'other',
]);

export const ticketStatus = pgEnum('ticket_status', ['open', 'in_progress', 'resolved']);

export const ticketSource = pgEnum('ticket_source', ['agent', 'api', 'dashboard']);

/** Result of one agent tool call. Append-only rows; see agent_actions. */
export const agentActionStatus = pgEnum('agent_action_status', [
  'ok',
  'refused',
  'needs_verification',
  'awaiting_confirmation',
  'approved',
  'ticketed',
  'failed',
]);

export const orderActionKind = pgEnum('order_action_kind', ['cancel']);

export const orderActionStatus = pgEnum('order_action_status', [
  'pending',
  'executing',
  'done',
  'failed',
  'dead',
]);
