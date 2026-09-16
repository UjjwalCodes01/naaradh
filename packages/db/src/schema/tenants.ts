import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  smallint,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { pgTable } from 'drizzle-orm/pg-core';
import {
  citext,
  createdAt,
  id,
  idFormat,
  minorUnits,
  phoneHash,
  ts,
  updatedAt,
  bytea,
} from './columns.js';
import {
  amdMode,
  apiKeyKind,
  billingProvider,
  billingStatus,
  dataRegion,
  integrationKind,
  integrationStatus,
  numberSeries,
  numberStatus,
  profileStatus,
  purpose,
  scriptStatus,
  tenantStatus,
  useCaseKind,
  userRole,
} from './enums.js';

/**
 * A tenant is a merchant. Everything gate-relevant is an explicit column (so the gate can
 * read one row and so a migration review sees exactly what changed); everything cosmetic
 * lives in `settings`.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: id(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    country: text('country').notNull(), // ISO 3166-1 alpha-2
    dataRegion: dataRegion('data_region').notNull(),
    /** The merchant's own zone — for reports and digests only. Windows use the RECIPIENT's zone. */
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    currency: text('currency').notNull().default('INR'),
    gstin: text('gstin'),
    pan: text('pan'),

    status: tenantStatus('status').notNull().default('pending_review'),
    /** E-73 — until this instant, promotional is blocked and daily volume is capped. */
    reviewUntil: ts('review_until'),
    pausedAt: ts('paused_at'),
    pausedReason: text('paused_reason'),
    uninstalledAt: ts('uninstalled_at'),

    // DLT (SPEC §3.3). Promotional purposes require a linked PE.
    dltPeId: text('dlt_pe_id'),
    dltLinkedAt: ts('dlt_linked_at'),
    /**
     * ADR-0010 §5: set when a complaint is attributed to a promotional call; promotional calling
     * stops, everything else continues. Service-role column (not in the app role's UPDATE grant):
     * only staff lift it.
     */
    promotionalPausedAt: ts('promotional_paused_at'),
    promotionalPausedReason: text('promotional_paused_reason'),

    // Spend caps (E-32). Null = no cap of that kind.
    spendCapDailyPaise: minorUnits('spend_cap_daily_paise'),
    spendCapMonthlyPaise: minorUnits('spend_cap_monthly_paise'),
    maxConcurrency: smallint('max_concurrency').notNull().default(2),
    /** Recordings/transcripts. Legal records have their own, longer, retention. */
    retentionDays: smallint('retention_days').notNull().default(90),

    // Engine routing (AGENTS §2.1).
    engineOverride: text('engine_override'),
    multiEngineOk: boolean('multi_engine_ok').notNull().default(false),
    amdModeTransactional: amdMode('amd_mode_transactional').notNull().default('continue'),
    amdModePromotional: amdMode('amd_mode_promotional').notNull().default('hangup'),

    // Invariant 14 — both default OFF, and even when on, require confidence >= 0.9.
    autoCancelEnabled: boolean('auto_cancel_enabled').notNull().default(false),
    addressWriteEnabled: boolean('address_write_enabled').notNull().default(false),
    /** Q-07 — default off: verbal opt-out suppresses internally, never written to Shopify. */
    shopifySyncOptout: boolean('shopify_sync_optout').notNull().default(false),

    billingProvider: billingProvider('billing_provider'),
    billingStatus: billingStatus('billing_status').notNull().default('none'),
    /** E-50 — dispatch continues until this instant after a freeze, then pauses. */
    billingGraceUntil: ts('billing_grace_until'),
    /** Last day of the free/pilot allowance, if any. */
    planCode: text('plan_code'),
    /** Support-line plan (ADR-0008) — a tenant can hold an outbound AND an inbound plan. */
    inboundPlanCode: text('inbound_plan_code'),
    /**
     * Enterprise pricing overrides (ADR-0008), minor units of the tenant currency:
     * outcome_included, outcome_unit_minor, outbound_fee_minor, inbound_included_minutes,
     * inbound_unit_minor, inbound_fee_minor. SERVICE-ROLE ONLY — unlike `settings`, which the
     * merchant can edit, so prices can never be self-served.
     */
    billingOverrides: jsonb('billing_overrides').notNull().default({}),

    settings: jsonb('settings').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('tenants_id_format', idFormat(t.id, 'ten')),
    check('tenants_retention_range', sql`${t.retentionDays} between 30 and 365`),
    check('tenants_concurrency_range', sql`${t.maxConcurrency} between 1 and 100`),
    check('tenants_country_iso', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check('tenants_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    index('tenants_status_idx').on(t.status),
  ],
).enableRLS();

export const users = pgTable(
  'users',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    email: citext('email').notNull(),
    name: text('name'),
    role: userRole('role').notNull().default('viewer'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    lastLoginAt: ts('last_login_at'),
    disabledAt: ts('disabled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('users_id_format', idFormat(t.id, 'usr')),
    uniqueIndex('users_tenant_email_uq').on(t.tenantId, t.email),
  ],
).enableRLS();

/**
 * E-70. The key itself is never stored: `key_hash` is SHA-256 of the full key, `prefix` is
 * the first 12 characters for display ("nrd_live_ab12…"). Public keys (`nrd_pk_`) get
 * `intents:create` only, a domain allow-list and a tighter rate limit.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    kind: apiKeyKind('kind').notNull(),
    keyHash: text('key_hash').notNull(),
    prefix: text('prefix').notNull(),
    scopes: text('scopes').array().notNull(),
    allowedDomains: text('allowed_domains').array(),
    ipAllowlist: text('ip_allowlist').array(),
    /** Intents per day this key may create; null = tenant default. */
    dailyCap: integer('daily_cap'),
    createdByUserId: text('created_by_user_id'),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    revokedReason: text('revoked_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    check('api_keys_id_format', idFormat(t.id, 'key')),
    uniqueIndex('api_keys_hash_uq').on(t.keyHash),
    index('api_keys_tenant_idx').on(t.tenantId),
  ],
).enableRLS();

/**
 * One row per connected system. `external_id` is the Shopify shop domain, the Woo site URL,
 * the CRM org id. Credentials are never here — `credentials_secret_ref` names a Secret
 * Manager secret.
 */
export const integrations = pgTable(
  'integrations',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: integrationKind('kind').notNull(),
    externalId: text('external_id').notNull(),
    credentialsSecretRef: text('credentials_secret_ref'),
    scopes: text('scopes').array(),
    apiVersion: text('api_version'),
    status: integrationStatus('status').notNull().default('active'),
    /** Shopify: whether the store uses Shopify Checkout (E-14) — decides abandoned-cart source. */
    metadata: jsonb('metadata').notNull().default({}),
    installedAt: ts('installed_at').notNull().defaultNow(),
    uninstalledAt: ts('uninstalled_at'),
    /** shop/redact arrives 48h after uninstall; purge is due then (E-48). */
    purgeDueAt: ts('purge_due_at'),
    purgedAt: ts('purged_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('integrations_id_format', idFormat(t.id, 'itg')),
    // The hooks service resolves a tenant from (kind, external_id) before any tenant context
    // exists — see resolve_tenant_by_integration() in migration 0001.
    uniqueIndex('integrations_kind_external_uq').on(t.kind, t.externalId),
    index('integrations_tenant_idx').on(t.tenantId),
  ],
).enableRLS();

export const useCases = pgTable(
  'use_cases',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: useCaseKind('kind').notNull(),
    purpose: purpose('purpose').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    /**
     * Per-use-case behaviour: value thresholds (E-47 `min_order_value_paise`,
     * `human_above_paise`), retry policy, default locale, transfer target, pilot percentage.
     * Validated by zod in packages/compliance before use.
     */
    config: jsonb('config').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('use_cases_id_format', idFormat(t.id, 'usc')),
    uniqueIndex('use_cases_tenant_kind_uq').on(t.tenantId, t.kind),
  ],
).enableRLS();

/**
 * Immutable per version (universal rule 10): once approved, `body` cannot change — the
 * `scripts_immutable` trigger in migration 0001 enforces it. A new version is a new row.
 * Every attempt records the script id + version it ran.
 */
export const scripts = pgTable(
  'scripts',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    useCaseId: text('use_case_id')
      .notNull()
      .references(() => useCases.id),
    version: integer('version').notNull(),
    locale: text('locale').notNull(),
    body: jsonb('body').notNull(),
    /** Registered DLT content template id, required for promotional traffic. */
    dltTemplateId: text('dlt_template_id'),
    status: scriptStatus('status').notNull().default('draft'),
    /** Set by the disclosure validator at approval time; approval is refused without it. */
    disclosureValidatedAt: ts('disclosure_validated_at'),
    approvedByUserId: text('approved_by_user_id'),
    approvedAt: ts('approved_at'),
    retiredAt: ts('retired_at'),
    /** A/B: which arm this version belongs to, if any (SPEC §10.4). */
    abArm: text('ab_arm'),
    createdAt: createdAt(),
  },
  (t) => [
    check('scripts_id_format', idFormat(t.id, 'scr')),
    check('scripts_version_positive', sql`${t.version} > 0`),
    check(
      'scripts_approved_requires_validation',
      sql`${t.status} <> 'approved' or (${t.approvedAt} is not null and ${t.disclosureValidatedAt} is not null)`,
    ),
    uniqueIndex('scripts_tenant_usecase_locale_version_uq').on(
      t.tenantId,
      t.useCaseId,
      t.locale,
      t.version,
    ),
    index('scripts_lookup_idx').on(t.tenantId, t.useCaseId, t.locale, t.status),
  ],
).enableRLS();

/**
 * Who answers a merchant's number, and how (ADR-0006, SPEC §10.5). Not a branch script: an
 * inbound caller can ask anything, so a profile is greeting + persona + hours + enabled tools
 * + pinned facts + where to send the call when the agent cannot take it.
 *
 * `greeting` is validated by the same disclosure validator as outbound scripts (invariant 7):
 * no profile becomes `active` without the AI + recording disclosure in its first sentence.
 * `version` increments on every change and is stamped on each inbound attempt.
 */
export const inboundProfiles = pgTable(
  'inbound_profiles',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    status: profileStatus('status').notNull().default('draft'),
    locale: text('locale').notNull().default('hi-IN'),
    /** First utterance. Must contain the AI + recording disclosure for `locale`. */
    greeting: text('greeting').notNull(),
    /** One or two lines of tone/persona. Never instructions that loosen guardrails. */
    persona: text('persona'),
    /** `{ zone, days: [1..7], open: 'HH:MM', close: 'HH:MM' }` — used for transfers and closed messages. */
    businessHours: jsonb('business_hours').notNull(),
    /** Subset of the tool names in packages/scripts/src/inbound/tools.ts. */
    toolsEnabled: text('tools_enabled').array().notNull(),
    /** ≤ 20 short facts the agent may state verbatim (delivery time, return window, COD availability). */
    pinnedFacts: text('pinned_facts').array().notNull(),
    /** Spoken when the call cannot be taken and there is no fallback forward. */
    closedMessage: text('closed_message').notNull(),
    /** The merchant's own number to forward to when the agent cannot answer (E-92). Staff key pair. */
    fallbackForwardEnc: bytea('fallback_forward_enc'),
    fallbackForwardKid: smallint('fallback_forward_kid'),
    fallbackForwardMasked: text('fallback_forward_masked'),
    transferTargetId: text('transfer_target_id').references(() => transferTargets.id),
    maxDurationSec: smallint('max_duration_sec').notNull().default(600),
    maxConcurrent: smallint('max_concurrent').notNull().default(2),
    /** E-88 — calls from one caller to this tenant per rolling hour before the abuse message. */
    maxCallsPerCallerHour: smallint('max_calls_per_caller_hour').notNull().default(6),
    /** Null = plan default. Reaching it forwards to the fallback (E-92). */
    monthlyMinuteCap: integer('monthly_minute_cap'),
    /** Invariant 14 — the agent may execute a two-step cancellation only when this is on. */
    agentCancelEnabled: boolean('agent_cancel_enabled').notNull().default(false),
    voiceId: text('voice_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('inbound_profiles_id_format', idFormat(t.id, 'ipr')),
    check('inbound_profiles_version_positive', sql`${t.version} > 0`),
    check('inbound_profiles_concurrency', sql`${t.maxConcurrent} between 1 and 100`),
    check('inbound_profiles_caller_limit', sql`${t.maxCallsPerCallerHour} between 1 and 60`),
    check('inbound_profiles_duration', sql`${t.maxDurationSec} between 60 and 1800`),
    check('inbound_profiles_pinned_facts_max', sql`cardinality(${t.pinnedFacts}) <= 20`),
    check(
      'inbound_profiles_fallback_pair',
      sql`(${t.fallbackForwardEnc} is null) = (${t.fallbackForwardKid} is null)`,
    ),
    index('inbound_profiles_tenant_idx').on(t.tenantId, t.status),
  ],
).enableRLS();

/**
 * CLI pool. `tenant_id` NULL = shared Naaradh pool. `purpose_allowed` is deliberately NOT
 * NULL with NO default: a human decides what each number may be used for, per Q-01. An empty
 * array is a valid, explicit "nothing yet".
 */
export const numbers = pgTable(
  'numbers',
  {
    id: id(),
    tenantId: text('tenant_id').references(() => tenants.id),
    e164: text('e164').notNull(),
    region: text('region').notNull(), // ISO country of the number
    series: numberSeries('series').notNull(),
    provider: text('provider').notNull(), // exotel | plivo | twilio | telnyx
    engine: text('engine').notNull(), // which adapter can dial from it
    purposeAllowed: purpose('purpose_allowed').array().notNull(),
    inboundEnabled: boolean('inbound_enabled').notNull().default(false),
    /** Which profile answers calls to this number (ADR-0006). Requires tenant_id. */
    inboundProfileId: text('inbound_profile_id').references(() => inboundProfiles.id),
    status: numberStatus('status').notNull().default('warming'),
    /** E-28 — retire below 0.25. Maintained by the cli-health job. */
    answerRate7d: numeric('answer_rate_7d', { precision: 5, scale: 4 }),
    lastUsedAt: ts('last_used_at'),
    /** Evidence for the series decision — TSP letter reference (Q-01). */
    provisioningNote: text('provisioning_note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('numbers_id_format', idFormat(t.id, 'num')),
    check('numbers_e164_format', sql`${t.e164} ~ '^\\+[1-9][0-9]{7,14}$'`),
    uniqueIndex('numbers_e164_uq').on(t.e164),
    check(
      'numbers_inbound_needs_tenant',
      sql`${t.inboundProfileId} is null or ${t.tenantId} is not null`,
    ),
    index('numbers_pool_idx').on(t.region, t.status, t.engine),
  ],
).enableRLS();

/**
 * Where a live call may be transferred (E-30, Q-15). The caller NEVER chooses a number: the
 * agent may only transfer to a row here that is `verified_at` and `active`. That is the whole
 * defence against "transfer me to +44 premium-rate" toll fraud.
 */
export const transferTargets = pgTable(
  'transfer_targets',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    label: text('label').notNull(),
    phoneHash: phoneHash().notNull(),
    /**
     * Encrypted with the STAFF key pair (not the customer one): apps/voice holds the staff
     * private key so it can hand the number to the engine at transfer time, and can never
     * decrypt a customer number (invariant 19).
     */
    phoneEnc: bytea('phone_enc').notNull(),
    phoneEncKid: smallint('phone_enc_kid').notNull(),
    phoneMasked: text('phone_masked').notNull(),
    region: text('region').notNull(),
    /** Verified by a test call, or by an owner/manager attestation (audited); null = not transferable. */
    verifiedAt: ts('verified_at'),
    active: boolean('active').notNull().default(true),
    /** `{ zone, days: [1..5], open: '09:00', close: '18:00' }` — no transfer outside it. */
    hours: jsonb('hours'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('transfer_targets_id_format', idFormat(t.id, 'trf')),
    index('transfer_targets_tenant_idx').on(t.tenantId, t.active),
  ],
).enableRLS();

/** Feature flags (CLAUDE.md: table-backed, no external SaaS). `tenant_id` NULL = global default. */
export const flags = pgTable(
  'flags',
  {
    tenantId: text('tenant_id').references(() => tenants.id),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    reason: text('reason'),
    updatedBy: text('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    // NULLS NOT DISTINCT so there is exactly one global default per key.
    unique('flags_tenant_key_uq').on(t.tenantId, t.key).nullsNotDistinct(),
  ],
).enableRLS();
