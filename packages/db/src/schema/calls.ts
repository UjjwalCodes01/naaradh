import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, id, idFormat, minorUnits, phoneHash, ts, updatedAt } from './columns.js';
import { contacts } from './contacts.js';
import {
  amdMode,
  answeredBy,
  attemptStatus,
  callDirection,
  callerVerification,
  campaignStatus,
  disputeStatus,
  extractionMethod,
  intentSource,
  intentStatus,
  outcome,
  purpose,
  transferResult,
  useCaseKind,
  writebackStatus,
} from './enums.js';
import {
  inboundProfiles,
  numbers,
  scripts,
  tenants,
  transferTargets,
  useCases,
} from './tenants.js';

export const campaigns = pgTable(
  'campaigns',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    useCaseId: text('use_case_id')
      .notNull()
      .references(() => useCases.id),
    name: text('name').notNull(),
    source: text('source'),
    status: campaignStatus('status').notNull().default('draft'),
    total: integer('total').notNull().default(0),
    dispatched: integer('dispatched').notNull().default(0),
    completed: integer('completed').notNull().default(0),
    windowStart: ts('window_start'),
    windowEnd: ts('window_end'),
    maxConcurrency: smallint('max_concurrency'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('campaigns_id_format', idFormat(t.id, 'cmp')),
    index('campaigns_tenant_idx').on(t.tenantId, t.status),
  ],
).enableRLS();

/**
 * The decision to (maybe) call someone. One per (source event, use case); idempotent on
 * `idempotency_key` (E-52). `not_before`/`not_after` are the hard envelope — for COD,
 * `not_after = event_ts + 30 min` and is never extended (invariant 4).
 */
export const callIntents = pgTable(
  'call_intents',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    useCaseId: text('use_case_id')
      .notNull()
      .references(() => useCases.id),
    /** Denormalised so the gate reads one row. */
    useCase: useCaseKind('use_case').notNull(),
    purpose: purpose('purpose').notNull(),
    direction: callDirection('direction').notNull().default('outbound'),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id),
    phoneHash: phoneHash().notNull(),
    /** Recipient's ISO country — chooses window, consent type, CLI pool (invariant 2). */
    recipientRegion: text('recipient_region').notNull(),
    source: intentSource('source').notNull(),
    /** Primary order/checkout/lead id. */
    externalRef: text('external_ref').notNull(),
    /** E-42 — several orders from one phone within 30 min ride one call. */
    externalRefs: text('external_refs').array().notNull(),
    campaignId: text('campaign_id').references(() => campaigns.id),
    /** From the SOURCE event (order.created_at), never now(). The 30-min clock starts here. */
    eventTs: ts('event_ts').notNull(),
    notBefore: ts('not_before').notNull(),
    notAfter: ts('not_after').notNull(),
    /** E-29: cod_confirm 100 > appointment 50 > abandoned_cart 10. Higher first. */
    priority: smallint('priority').notNull().default(50),
    status: intentStatus('status').notNull().default('CREATED'),
    /** Machine reason, e.g. 'window:transactional_expired'. Dashboard renders the explanation. */
    gatedReason: text('gated_reason'),
    /** Every gate step with its verdict, in order — the "prove why" record. */
    gateTrace: jsonb('gate_trace'),
    /** Sanitised, allow-listed (E-72). Rendered into user-visible slots only. */
    variables: jsonb('variables').notNull().default({}),
    locale: text('locale').notNull(),
    scriptId: text('script_id').references(() => scripts.id),
    attemptsCount: smallint('attempts_count').notNull().default(0),
    /**
     * ADR-0005: the table is the queue. Due when status ∈ (SCHEDULED, RETRY_SCHEDULED) and
     * next_attempt_at <= now(). Set to not_before on creation, to the gate's retryAt on a
     * temporary refusal, to nextRetryAt() after a soft failure.
     */
    nextAttemptAt: ts('next_attempt_at'),
    /** Set by the dispatcher's SKIP LOCKED claim; cleared on completion. Reconcile frees stale claims. */
    claimedAt: ts('claimed_at'),
    claimedBy: text('claimed_by'),
    idempotencyKey: text('idempotency_key').notNull(),
    /** Order value, for E-47 thresholds and for the dashboard. */
    valuePaise: minorUnits('value_paise'),
    currency: text('currency'),
    cancelledAt: ts('cancelled_at'),
    cancelReason: text('cancel_reason'),
    completedAt: ts('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('call_intents_id_format', idFormat(t.id, 'int')),
    check('call_intents_envelope', sql`${t.notBefore} <= ${t.notAfter}`),
    check('call_intents_refs_nonempty', sql`cardinality(${t.externalRefs}) >= 1`),
    uniqueIndex('call_intents_idempotency_uq').on(t.idempotencyKey),
    index('call_intents_tenant_status_idx').on(t.tenantId, t.status, t.createdAt),
    // The dispatcher's claim query (ADR-0005): due intents, highest priority first.
    index('call_intents_queue_idx')
      .on(t.priority, t.nextAttemptAt)
      .where(sql`${t.status} in ('SCHEDULED','RETRY_SCHEDULED')`),
    index('call_intents_claimed_idx')
      .on(t.claimedAt)
      .where(sql`${t.status} = 'DISPATCHING'`),
    index('call_intents_phone_idx').on(t.phoneHash, t.purpose, t.createdAt),
    index('call_intents_external_idx').on(t.tenantId, t.externalRef),
  ],
).enableRLS();

/**
 * One dial. Written BEFORE the engine is called (status DISPATCHING) so a crash between the
 * two leaves evidence, never a phantom call. The customer's number is not on this row — it is
 * reachable only through `contact_id` → `phone_enc`, decrypted at dial time.
 */
export const callAttempts = pgTable(
  'call_attempts',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Null for inbound calls, which have no scheduled intent. */
    intentId: text('intent_id').references(() => callIntents.id),
    /**
     * Always set for outbound. Inbound: null when the caller withheld their number (E-80) or
     * rang from a number we could not store as a contact (e.g. a landline) — see the check below.
     */
    contactId: text('contact_id').references(() => contacts.id),
    /** Null only for an inbound call with a withheld caller ID. */
    phoneHash: phoneHash(),
    direction: callDirection('direction').notNull().default('outbound'),
    purpose: purpose('purpose').notNull(),
    externalRef: text('external_ref'),
    attemptNo: smallint('attempt_no').notNull(),
    engine: text('engine').notNull(),
    engineCallId: text('engine_call_id'),
    engineAgentId: text('engine_agent_id'),
    /**
     * OUR number on the call — the CLI we dialled from (outbound) or the number the customer
     * called (inbound). Never the customer's number; that is reachable only via contact_id.
     */
    fromE164: text('from_e164').notNull(),
    numberId: text('number_id').references(() => numbers.id),
    scriptId: text('script_id').references(() => scripts.id),
    scriptVersion: integer('script_version'),
    /** ADR-0010: the registered DLT content template the call ran under (promotional) — CDR mapping. */
    dltTemplateId: text('dlt_template_id'),
    amdMode: amdMode('amd_mode').notNull(),
    maxDurationSec: smallint('max_duration_sec').notNull(),
    /** Sent to the vendor as its idempotency key; replay must not dial twice (invariant 10). */
    idempotencyKey: text('idempotency_key').notNull(),

    status: attemptStatus('status').notNull().default('DISPATCHING'),
    scheduledAt: ts('scheduled_at'),
    dispatchedAt: ts('dispatched_at'),
    startedAt: ts('started_at'),
    answeredAt: ts('answered_at'),
    endedAt: ts('ended_at'),
    lastEventAt: ts('last_event_at'),
    answeredBy: answeredBy('answered_by'),
    endReason: text('end_reason'),
    durationSec: integer('duration_sec'),
    billableSec: integer('billable_sec'),
    /** Seconds of detected human speech (E-25 pocket-answer rule). */
    humanSpeechSec: integer('human_speech_sec'),

    /** Invariant 7 — set when the disclosure segment finished playing. Null = not disclosed. */
    aiDisclosedAt: ts('ai_disclosed_at'),
    recordingDisclosedAt: ts('recording_disclosed_at'),
    detectedLocale: text('detected_locale'),

    recordingUri: text('recording_uri'),
    transcriptUri: text('transcript_uri'),
    /** E-34 — vendor URL persisted to our bucket within 10 min; null after erasure. */
    recordingPersistedAt: ts('recording_persisted_at'),
    /** P2-CMP-4 / erasure: recording + transcript deleted from our store; URIs nulled. */
    mediaPurgedAt: ts('media_purged_at'),

    transferTargetId: text('transfer_target_id').references(() => transferTargets.id),
    transferResult: transferResult('transfer_result'),

    // Inbound (ADR-0006). Identity lives HERE, set by tools — never in the prompt, so the
    // model cannot talk itself into a higher level (AGENTS §5.8).
    inboundProfileId: text('inbound_profile_id').references(() => inboundProfiles.id),
    profileVersion: integer('profile_version'),
    callerWithheld: boolean('caller_withheld').notNull().default(false),
    callerVerification: callerVerification('caller_verification').notNull().default('none'),
    callerVerifiedAt: ts('caller_verified_at'),
    /** Order ids (orders.id) this caller has proven they may discuss, by caller ID or knowledge. */
    verifiedOrderIds: text('verified_order_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** E-94 — three failed verify_caller attempts lock verification for the call. */
    verifyFailures: smallint('verify_failures').notNull().default(0),
    admissionTrace: jsonb('admission_trace'),

    // Cost (E-33, E-63). Vendor CDR values in the vendor's currency plus INR at day rate.
    costPaiseEngine: minorUnits('cost_paise_engine'),
    costPaiseTelephony: minorUnits('cost_paise_telephony'),
    vendorCostMinor: minorUnits('vendor_cost_minor'),
    vendorCostCurrency: text('vendor_cost_currency'),
    fxRate: numeric('fx_rate', { precision: 12, scale: 6 }),

    error: jsonb('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('call_attempts_id_format', idFormat(t.id, 'att')),
    check('call_attempts_attempt_no_positive', sql`${t.attemptNo} > 0`),
    check(
      'call_attempts_outbound_has_intent',
      sql`${t.direction} = 'inbound' or ${t.intentId} is not null`,
    ),
    uniqueIndex('call_attempts_idempotency_uq').on(t.idempotencyKey),
    check(
      'call_attempts_party_known',
      sql`(${t.direction} = 'outbound' and ${t.contactId} is not null and ${t.phoneHash} is not null) or (${t.direction} = 'inbound' and (${t.phoneHash} is not null or ${t.callerWithheld}))`,
    ),
    check('call_attempts_verify_failures', sql`${t.verifyFailures} between 0 and 10`),
    check(
      'call_attempts_inbound_has_profile',
      sql`${t.direction} = 'outbound' or ${t.inboundProfileId} is not null`,
    ),
    uniqueIndex('call_attempts_engine_call_uq')
      .on(t.engine, t.engineCallId)
      .where(sql`${t.engineCallId} is not null`),
    // Retention sweep: ended attempts that still hold media.
    index('call_attempts_media_retention_idx')
      .on(t.tenantId, t.endedAt)
      .where(
        sql`${t.mediaPurgedAt} is null and (${t.recordingUri} is not null or ${t.transcriptUri} is not null)`,
      ),
    index('call_attempts_intent_idx').on(t.intentId, t.attemptNo),
    index('call_attempts_tenant_idx').on(t.tenantId, t.createdAt),
    // Attempt-limit query (gate step 9): per (phone_hash, purpose, external_ref) in a window.
    index('call_attempts_limits_idx').on(t.phoneHash, t.purpose, t.externalRef, t.createdAt),
    // Stuck-attempt poller (E-21): live statuses older than N minutes.
    index('call_attempts_live_idx')
      .on(t.status, t.lastEventAt)
      .where(
        sql`${t.status} in ('DISPATCHING','UNCERTAIN','DIALING','RINGING','IN_CONVERSATION','TRANSFERRING')`,
      ),
  ],
).enableRLS();

export const callOutcomes = pgTable(
  'call_outcomes',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => callAttempts.id),
    intentId: text('intent_id').references(() => callIntents.id),
    outcome: outcome('outcome').notNull(),
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull(),
    /** Validated against the use case's extraction schema (zod). Invalid → 'inconclusive'. */
    extracted: jsonb('extracted').notNull().default({}),
    extractionMethod: extractionMethod('extraction_method').notNull(),
    /** Computed by isBillable(): human answered AND outcome in the billable five AND not superseded. */
    billable: boolean('billable').notNull(),
    /** Why not, when not: 'not_human' | 'outcome_not_billable' | 'superseded' | 'min_speech'. */
    billableReason: text('billable_reason').notNull(),
    /** E-40 — order cancelled before/while ringing; never billed. */
    superseded: boolean('superseded').notNull().default(false),
    billedAt: ts('billed_at'),
    billingLedgerId: text('billing_ledger_id'),
    writebackStatus: writebackStatus('writeback_status').notNull().default('pending'),
    writebackError: text('writeback_error'),
    writebackAt: ts('writeback_at'),
    /**
     * P1-SHOP-2: the write-back is a queue on this row, run by the `writebacks` worker outside
     * any transaction. Due when status ∈ (pending, failed) and next_at <= now(); claiming
     * pushes next_at forward (a lease), so a crashed worker's row comes back on its own.
     */
    writebackAttempts: smallint('writeback_attempts').notNull().default(0),
    writebackNextAt: ts('writeback_next_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('call_outcomes_id_format', idFormat(t.id, 'out')),
    check('call_outcomes_confidence_range', sql`${t.confidence} between 0 and 1`),
    check('call_outcomes_superseded_not_billable', sql`not (${t.superseded} and ${t.billable})`),
    uniqueIndex('call_outcomes_attempt_uq').on(t.attemptId),
    index('call_outcomes_tenant_idx').on(t.tenantId, t.createdAt),
    index('call_outcomes_writeback_due_idx')
      .on(t.writebackNextAt)
      .where(
        sql`${t.writebackStatus} in ('pending','failed') and ${t.writebackNextAt} is not null`,
      ),
    index('call_outcomes_billing_idx')
      .on(t.tenantId, t.billedAt)
      .where(sql`${t.billable} and ${t.billedAt} is null`),
  ],
).enableRLS();

/** E-62 — merchant disputes a billable outcome within 7 days; admin review; credit note. */
export const outcomeDisputes = pgTable(
  'outcome_disputes',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    outcomeId: text('outcome_id')
      .notNull()
      .references(() => callOutcomes.id),
    openedByUserId: text('opened_by_user_id').notNull(),
    reason: text('reason').notNull(),
    status: disputeStatus('status').notNull().default('open'),
    resolvedBy: text('resolved_by'),
    resolution: text('resolution'),
    creditLedgerId: text('credit_ledger_id'),
    openedAt: ts('opened_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('outcome_disputes_id_format', idFormat(t.id, 'dsp')),
    uniqueIndex('outcome_disputes_outcome_uq').on(t.outcomeId),
    index('outcome_disputes_tenant_idx').on(t.tenantId, t.status),
  ],
).enableRLS();
