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
  referralStatus,
  scriptStatus,
  ssoStatus,
  stirShakenAttestation,
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

    /**
     * P7-ENT-1 custom voices: `{ "<engine>": { "<locale>": "<vendor voice id>" } }`, set by staff
     * once a voice (often the merchant's own, cloned) exists on that engine's account. Absent →
     * the engine's default voice for the locale. Service-role column: not in the app role's
     * UPDATE grant, because a voice id only means something after it is provisioned with the
     * vendor. Applies to outbound agents; an inbound profile carries its own `voice_id`.
     */
    voiceOverrides: jsonb('voice_overrides').notNull().default({}),
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
    check('tenants_voice_overrides_object', sql`jsonb_typeof(${t.voiceOverrides}) = 'object'`),
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
 * P7-ENT-1: one OpenID Connect identity provider per tenant (Okta, Microsoft Entra, Google
 * Workspace …) for the dashboard.
 *
 * SSO never creates users: it signs in people the tenant already invited, matched by email, and
 * only for `email_domains`. So a misconfigured or hostile provider can at most sign in this
 * tenant's own invited users — never another tenant's, and never a stranger.
 *
 * Staff reach it through a per-tenant link (`slug`), not by typing an email: discovery by email
 * domain would let any tenant claim someone else's domain and send its people to a look-alike
 * sign-in page. The slug is random, so it lists nothing.
 *
 * The client secret is sealed (AES-256-GCM, `SSO_SECRET_KEY`, AAD = tenant id): the database
 * alone cannot sign anyone in, and a sealed secret copied onto another tenant's row fails to open.
 */
export const tenantSso = pgTable(
  'tenant_sso',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    slug: text('slug').notNull(),
    issuer: text('issuer').notNull(),
    clientId: text('client_id').notNull(),
    clientSecretEnc: bytea('client_secret_enc').notNull(),
    clientSecretIv: bytea('client_secret_iv').notNull(),
    clientSecretTag: bytea('client_secret_tag').notNull(),
    clientSecretKid: smallint('client_secret_kid').notNull(),
    /** Lower-case domains whose addresses this provider may sign in. */
    emailDomains: text('email_domains').array().notNull(),
    status: ssoStatus('status').notNull().default('testing'),
    /**
     * When on, the emailed sign-in link is withheld from this tenant's users in `email_domains`
     * — except owners, who always keep it as a way back in if the provider breaks.
     */
    enforced: boolean('enforced').notNull().default(false),
    lastSuccessAt: ts('last_success_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('tenant_sso_id_format', idFormat(t.id, 'sso')),
    check('tenant_sso_slug_format', sql`${t.slug} ~ '^[a-z0-9]{16}$'`),
    check('tenant_sso_issuer_https', sql`${t.issuer} ~ '^https://[^/]+'`),
    check('tenant_sso_domains', sql`cardinality(${t.emailDomains}) between 1 and 20`),
    check(
      'tenant_sso_enforced_needs_proof',
      sql`not ${t.enforced} or (${t.status} = 'active' and ${t.lastSuccessAt} is not null)`,
    ),
    uniqueIndex('tenant_sso_tenant_uq').on(t.tenantId),
    uniqueIndex('tenant_sso_slug_uq').on(t.slug),
  ],
).enableRLS();

/** P7-GTM-1: each merchant's own code, created the first time they open the referrals page. */
export const referralCodes = pgTable(
  'referral_codes',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** 8 characters without look-alikes (no 0/O, 1/I/L), so it survives being read aloud. */
    code: text('code').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('referral_codes_id_format', idFormat(t.id, 'rfc')),
    check('referral_codes_format', sql`${t.code} ~ '^[A-HJ-KMNP-Z2-9]{8}$'`),
    uniqueIndex('referral_codes_tenant_uq').on(t.tenantId),
    uniqueIndex('referral_codes_code_uq').on(t.code),
  ],
).enableRLS();

/**
 * P7-GTM-1: one merchant referred by another. `tenant_id` is the REFERRED merchant (one row at
 * most — nobody is referred twice); both sides may read the row. Created only through
 * `claim_referral()`, which applies the anti-abuse rules; moved on only by the billing worker.
 * `referred_name` is a snapshot at claim time, so the referrer never needs to read the other
 * tenant's row. The reward, when there is one, is a `credit` ledger row with `ref` = this id,
 * which the ledger's unique index makes impossible to write twice.
 */
export const referrals = pgTable(
  'referrals',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    referrerTenantId: text('referrer_tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    referredName: text('referred_name').notNull(),
    status: referralStatus('status').notNull().default('claimed'),
    claimedAt: ts('claimed_at').notNull(),
    qualifiedAt: ts('qualified_at'),
    rewardedAt: ts('rewarded_at'),
    creditLedgerId: text('credit_ledger_id'),
    voidReason: text('void_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('referrals_id_format', idFormat(t.id, 'rfl')),
    check('referrals_not_self', sql`${t.tenantId} <> ${t.referrerTenantId}`),
    uniqueIndex('referrals_referred_uq').on(t.tenantId),
    index('referrals_referrer_idx').on(t.referrerTenantId, t.status),
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
     * Validated by zod in compliance before use.
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
    /** Subset of the tool names in call-scripts/src/inbound/tools.ts. */
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
    /**
     * STIR/SHAKEN attestation this number's calls carry (P6-ENG-2). The gate dials North
     * American recipients only from numbers recorded as A, checked by a person from a test call
     * or the carrier's report — never assumed from a vendor's documentation.
     */
    attestation: stirShakenAttestation('attestation'),
    attestationCheckedAt: ts('attestation_checked_at'),
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
 * P7-INB-1: one number, different agents by time of day — the day team's profile during
 * opening hours, an after-hours profile that takes callbacks at night. Each row says "on these
 * days, between these local times, this profile answers"; when no row matches, the number's own
 * `inbound_profile_id` answers, so a schedule can only ever narrow the default, never leave a
 * number unanswered.
 *
 * Invariant 16 is untouched: the tenant still comes only from the called number. A schedule only
 * chooses among that tenant's own profiles, enforced by a trigger (foreign keys bypass RLS).
 * `end_time` before `start_time` is an overnight window (21:00–09:00); the lower `priority`
 * wins where two rows overlap.
 */
export const numberProfileSchedules = pgTable(
  'number_profile_schedules',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    numberId: text('number_id')
      .notNull()
      .references(() => numbers.id),
    inboundProfileId: text('inbound_profile_id')
      .notNull()
      .references(() => inboundProfiles.id),
    /** IANA zone the times are read in — the merchant's, not the caller's. */
    zone: text('zone').notNull(),
    /** ISO weekdays, 1 = Monday … 7 = Sunday. */
    days: smallint('days').array().notNull(),
    /** 'HH:MM', 24-hour. */
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    priority: smallint('priority').notNull().default(100),
    /**
     * Set when the merchant replaces the schedule. Rows are retired, never deleted — the app role
     * holds no DELETE anywhere — which also keeps a record of which profile answered when.
     */
    removedAt: ts('removed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('number_profile_schedules_id_format', idFormat(t.id, 'nps')),
    check(
      'number_profile_schedules_times',
      sql`${t.startTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${t.endTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${t.startTime} <> ${t.endTime}`,
    ),
    check(
      'number_profile_schedules_days',
      sql`cardinality(${t.days}) between 1 and 7 and ${t.days} <@ array[1,2,3,4,5,6,7]::smallint[]`,
    ),
    check('number_profile_schedules_priority', sql`${t.priority} between 0 and 1000`),
    index('number_profile_schedules_number_idx')
      .on(t.numberId, t.priority)
      .where(sql`${t.removedAt} is null`),
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
     * Encrypted with the STAFF key pair (not the customer one): voice holds the staff
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
