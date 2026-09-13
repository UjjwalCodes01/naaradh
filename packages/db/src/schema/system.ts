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
import {
  actorType,
  billingKind,
  billingPostingKind,
  billingPostingStatus,
  billingProvider,
  billingSubscriptionStatus,
  complaintReportStatus,
  complaintSource,
  complaintStatus,
  deliveryStatus,
  killSwitchScope,
  webhookEventStatus,
  webhookSource,
} from './enums.js';
import { tenants } from './tenants.js';

/**
 * E-05. Counted in a rolling 10-day window per tenant (pause at 3) and globally (kill at 5).
 * A complaint is counted while `received` or `valid`; only a human can mark it `invalid`.
 */
export const complaints = pgTable(
  'complaints',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    phoneHash: phoneHash().notNull(),
    source: complaintSource('source').notNull(),
    status: complaintStatus('status').notNull().default('received'),
    attemptId: text('attempt_id'),
    /** TRAI complaint reference, vendor ticket id, etc. */
    externalRef: text('external_ref'),
    receivedAt: ts('received_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
    resolvedBy: text('resolved_by'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('complaints_id_format', idFormat(t.id, 'cpl')),
    index('complaints_window_idx').on(t.tenantId, t.receivedAt),
    index('complaints_global_window_idx').on(t.receivedAt),
  ],
).enableRLS();

/**
 * Complaint intake queue (P2-CMP-1). Complaints arrive from places that cannot, or must not,
 * pause a tenant themselves: the public /do-not-call page (no tenant, no API key), a merchant
 * via the API, staff from the console. The `complaints` worker (service role) attributes each
 * report to the tenant that called the number, records it through `recordComplaint()` — which
 * may pause the tenant (E-05) — and marks the report. `tenant_id` is null until attributed.
 */
export const complaintReports = pgTable(
  'complaint_reports',
  {
    id: id(),
    tenantId: text('tenant_id').references(() => tenants.id),
    phoneHash: phoneHash().notNull(),
    source: complaintSource('source').notNull(),
    /** `dnc_page` | `api_key:<id>` | `staff:<email>` — who reported, never a phone number. */
    reporter: text('reporter').notNull(),
    externalRef: text('external_ref'),
    notes: text('notes'),
    reportedAt: ts('reported_at').notNull().defaultNow(),
    status: complaintReportStatus('status').notNull().default('pending'),
    complaintId: text('complaint_id').references(() => complaints.id),
    processedAt: ts('processed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('complaint_reports_id_format', idFormat(t.id, 'crp')),
    check(
      'complaint_reports_notes_len',
      sql`${t.notes} is null or char_length(${t.notes}) <= 1000`,
    ),
    index('complaint_reports_pending_idx')
      .on(t.reportedAt)
      .where(sql`${t.status} = 'pending'`),
    index('complaint_reports_tenant_idx').on(t.tenantId, t.reportedAt),
  ],
).enableRLS();

/**
 * APPEND-ONLY. Every charge and credit. `(tenant_id, kind, ref)` is unique so a usage record
 * can never be posted twice for one outcome (invariant 10, E-61).
 */
export const billingLedger = pgTable(
  'billing_ledger',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: billingKind('kind').notNull(),
    /** outcome id for kind='outcome'; dispute id for credits; period for fees. */
    ref: text('ref'),
    qty: integer('qty').notNull().default(1),
    unitMinor: minorUnits('unit_minor').notNull(),
    totalMinor: minorUnits('total_minor').notNull(),
    currency: text('currency').notNull(),
    period: text('period').notNull(), // YYYY-MM
    provider: billingProvider('provider').notNull(),
    /** Shopify usage record id / Razorpay invoice line / Stripe usage record. */
    providerRef: text('provider_ref'),
    providerPostedAt: ts('provider_posted_at'),
    invoicedAt: ts('invoiced_at'),
    // Margin (E-33, E-63)
    vendorCostMinor: minorUnits('vendor_cost_minor'),
    vendorCostCurrency: text('vendor_cost_currency'),
    fxRate: numeric('fx_rate', { precision: 12, scale: 6 }),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [
    check('billing_ledger_id_format', idFormat(t.id, 'led')),
    check('billing_ledger_total', sql`${t.totalMinor} = ${t.unitMinor} * ${t.qty}`),
    uniqueIndex('billing_ledger_ref_uq')
      .on(t.tenantId, t.kind, t.ref)
      .where(sql`${t.ref} is not null`),
    index('billing_ledger_period_idx').on(t.tenantId, t.period),
  ],
).enableRLS();

/**
 * APPEND-ONLY. Every state transition (SPEC §11), every reveal of a masked number (E-74),
 * every kill-switch flip, every suppression add/lift. `tenant_id` NULL = platform-level.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    tenantId: text('tenant_id').references(() => tenants.id),
    actorType: actorType('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    /** Redacted before write — never a phone number, never a transcript. */
    before: jsonb('before'),
    after: jsonb('after'),
    ipHash: text('ip_hash'),
    requestId: text('request_id'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [
    check('audit_log_id_format', idFormat(t.id, 'aud')),
    index('audit_log_tenant_at_idx').on(t.tenantId, t.at),
    index('audit_log_target_idx').on(t.targetType, t.targetId, t.at),
  ],
).enableRLS();

/**
 * Inbound webhook dedupe + replay store (E-22, E-52). Written by the hooks service with the
 * service role BEFORE a tenant is known. `payload` may contain PII (a Shopify order) and is
 * nulled by the retention job after 30 days; `rejected` rows never store a body.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    source: webhookSource('source').notNull(),
    /** X-Shopify-Webhook-Id, vendor event id, or sha256(body) where the vendor sends none. */
    externalEventId: text('external_event_id').notNull(),
    topic: text('topic').notNull(),
    tenantId: text('tenant_id').references(() => tenants.id),
    /** Shop domain / vendor account id — how tenant was (or could not be) resolved. */
    externalAccount: text('external_account'),
    status: webhookEventStatus('status').notNull().default('received'),
    signatureValid: boolean('signature_valid').notNull(),
    payload: jsonb('payload'),
    payloadSha256: text('payload_sha256'),
    headers: jsonb('headers'),
    pubsubMessageId: text('pubsub_message_id'),
    receivedAt: ts('received_at').notNull().defaultNow(),
    publishedAt: ts('published_at'),
    processedAt: ts('processed_at'),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('webhook_events_id_format', idFormat(t.id, 'evt')),
    check(
      'webhook_events_rejected_no_body',
      sql`${t.status} <> 'rejected' or ${t.payload} is null`,
    ),
    uniqueIndex('webhook_events_dedupe_uq').on(t.source, t.externalEventId),
    index('webhook_events_tenant_idx').on(t.tenantId, t.receivedAt),
    index('webhook_events_status_idx').on(t.status, t.receivedAt),
  ],
).enableRLS();

/** Merchant-registered outbound webhook endpoints (AGENTS §8). */
export const merchantWebhooks = pgTable(
  'merchant_webhooks',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    url: text('url').notNull(),
    /** Secret Manager ref of the signing secret; shown to the merchant once at creation. */
    secretRef: text('secret_ref').notNull(),
    events: text('events').array().notNull(),
    active: boolean('active').notNull().default(true),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    disabledAt: ts('disabled_at'),
    disabledReason: text('disabled_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('merchant_webhooks_id_format', idFormat(t.id, 'whk')),
    check('merchant_webhooks_https', sql`${t.url} ~ '^https://'`),
    index('merchant_webhooks_tenant_idx').on(t.tenantId, t.active),
  ],
).enableRLS();

/** One row per delivery attempt sequence; retried 5× with backoff, then `dead` (visible in dashboard). */
export const merchantWebhookDeliveries = pgTable(
  'merchant_webhook_deliveries',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => merchantWebhooks.id),
    eventType: text('event_type').notNull(),
    /** Stable event id sent in the payload so the merchant can dedupe. */
    eventId: text('event_id').notNull(),
    payload: jsonb('payload').notNull(),
    status: deliveryStatus('status').notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at'),
    lastStatusCode: smallint('last_status_code'),
    lastError: text('last_error'),
    deliveredAt: ts('delivered_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('merchant_webhook_deliveries_id_format', idFormat(t.id, 'dlv')),
    uniqueIndex('merchant_webhook_deliveries_event_uq').on(t.webhookId, t.eventId),
    index('merchant_webhook_deliveries_due_idx')
      .on(t.status, t.nextAttemptAt)
      .where(sql`${t.status} in ('pending','failed')`),
    index('merchant_webhook_deliveries_tenant_idx').on(t.tenantId, t.createdAt),
  ],
).enableRLS();

/**
 * Merchant email notifications (P2-WEB-4). Alerts are queued in the same transaction as the
 * merchant event that caused them (pipeline/outbox.ts); the daily summary is queued by the
 * notifications worker with `event_id` = the tenant's local date, so it is sent once per day
 * by construction. `data` is the event's PII-minimised payload — never a number or a name.
 */
export const merchantNotifications = pgTable(
  'merchant_notifications',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    eventId: text('event_id').notNull(),
    data: jsonb('data').notNull().default({}),
    status: deliveryStatus('status').notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at'),
    recipients: smallint('recipients'),
    lastError: text('last_error'),
    sentAt: ts('sent_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('merchant_notifications_id_format', idFormat(t.id, 'ntf')),
    uniqueIndex('merchant_notifications_event_uq').on(t.tenantId, t.kind, t.eventId),
    index('merchant_notifications_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} in ('pending','failed')`),
  ],
).enableRLS();

/**
 * Durable record of kill switches (invariant 12). Redis is the hot path the dispatcher reads
 * with a 5 s TTL; this table is what Redis is rebuilt from and what the audit trail cites.
 * `key` is '*' for global, an engine name, a tenant id or a campaign id.
 */
export const killSwitches = pgTable(
  'kill_switches',
  {
    scope: killSwitchScope('scope').notNull(),
    key: text('key').notNull(),
    active: boolean('active').notNull(),
    reason: text('reason'),
    setBy: text('set_by').notNull(),
    setAt: ts('set_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('kill_switches_scope_key_uq').on(t.scope, t.key)],
);

/** `Idempotency-Key` replay for the public API (AGENTS §8): 24h, returns the original response. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    key: text('key').notNull(),
    /** sha256 of method+path+body; a replay with a different body is a 422, not a replay. */
    requestHash: text('request_hash').notNull(),
    responseStatus: smallint('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_tenant_key_uq').on(t.tenantId, t.key),
    index('idempotency_keys_expires_idx').on(t.expiresAt),
  ],
).enableRLS();

/**
 * A merchant's subscription at a billing provider (ADR-0008): Shopify app subscription (recurring
 * fee + capped usage line) or Razorpay subscription. Status is what Naaradh last FETCHED from
 * the provider; `tenants.billing_status` is derived from the tenant's current row.
 */
export const billingSubscriptions = pgTable(
  'billing_subscriptions',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    provider: billingProvider('provider').notNull(),
    /** Shopify `gid://shopify/AppSubscription/…` · Razorpay `sub_…`. */
    providerSubscriptionId: text('provider_subscription_id').notNull(),
    /** Shopify: the usage line item usage records are posted against. */
    providerLineItemId: text('provider_line_item_id'),
    planCode: text('plan_code'),
    inboundPlanCode: text('inbound_plan_code'),
    status: billingSubscriptionStatus('status').notNull().default('pending'),
    /** Provider's own status string, as fetched (FROZEN, halted, …). */
    providerStatus: text('provider_status'),
    currency: text('currency').notNull(),
    recurringMinor: minorUnits('recurring_minor').notNull(),
    cappedAmountMinor: minorUnits('capped_amount_minor'),
    currentPeriodEnd: ts('current_period_end'),
    test: boolean('test').notNull().default(false),
    activatedAt: ts('activated_at'),
    cancelledAt: ts('cancelled_at'),
    lastFetchedAt: ts('last_fetched_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('billing_subscriptions_id_format', idFormat(t.id, 'bsb')),
    check('billing_subscriptions_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    uniqueIndex('billing_subscriptions_provider_uq').on(t.provider, t.providerSubscriptionId),
    index('billing_subscriptions_tenant_idx').on(t.tenantId, t.createdAt),
  ],
).enableRLS();

/**
 * The outbox of charges to providers (ADR-0008). The ledger is append-only, so "posted" lives
 * here: which ledger rows a posting covers, the amount in the PROVIDER's currency, the
 * idempotency key the provider sees, and the state. Shopify: one posting per chargeable ledger
 * row. Razorpay: one add-on per tenant per closed period.
 */
export const billingPostings = pgTable(
  'billing_postings',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    provider: billingProvider('provider').notNull(),
    kind: billingPostingKind('kind').notNull(),
    subscriptionId: text('subscription_id').references(() => billingSubscriptions.id),
    period: text('period').notNull(),
    ledgerIds: text('ledger_ids').array().notNull(),
    amountMinor: minorUnits('amount_minor').notNull(),
    currency: text('currency').notNull(),
    description: text('description').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: billingPostingStatus('status').notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at'),
    providerRef: text('provider_ref'),
    lastError: text('last_error'),
    postedAt: ts('posted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('billing_postings_id_format', idFormat(t.id, 'bps')),
    check('billing_postings_nonempty', sql`cardinality(${t.ledgerIds}) >= 1`),
    check('billing_postings_amount', sql`${t.amountMinor} >= 0`),
    uniqueIndex('billing_postings_idempotency_uq').on(t.idempotencyKey),
    index('billing_postings_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} in ('pending','failed')`),
    index('billing_postings_ledger_idx').using('gin', t.ledgerIds),
    index('billing_postings_tenant_idx').on(t.tenantId, t.period),
  ],
).enableRLS();
