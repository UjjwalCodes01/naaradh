import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { bytea, createdAt, id, idFormat, phoneHash, ts, updatedAt } from './columns.js';
import {
  consentAction,
  consentSource,
  dndResult,
  erasureSource,
  erasureStatus,
  phoneType,
  purposeScope,
  suppressionReason,
} from './enums.js';
import { tenants } from './tenants.js';

/**
 * A person the merchant may call. Invariant 8 in table form:
 *
 *   phone_hash    HMAC-SHA256(PHONE_HASH_KEY, e164) — every lookup and join uses this
 *   phone_enc     RSA-OAEP ciphertext of e164 — decryptable ONLY by the dispatcher and
 *                 results-consumer, which hold the private key; ingestion holds the public key
 *   phone_masked  "+91 60xxx xx001" — what the dashboard shows without a reveal
 *
 * There is no plaintext column and there never will be.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    phoneHash: phoneHash().notNull(),
    phoneEnc: bytea('phone_enc'),
    /** Which encryption key version produced `phone_enc`, for rotation. */
    phoneEncKid: smallint('phone_enc_kid'),
    phoneMasked: text('phone_masked').notNull(),
    /** ISO country derived from the number — this, not the merchant's country, picks the rules. */
    region: text('region').notNull(),
    phoneType: phoneType('phone_type').notNull().default('unknown'),
    phoneTypeCheckedAt: ts('phone_type_checked_at'),
    name: text('name'),
    localeHint: text('locale_hint'),
    /** IANA zone when known (US state from shipping address, say). Null = conservative window. */
    timezone: text('timezone'),
    source: text('source'),
    /** E-46 — merchant-tagged staff/test contact; never dialled. */
    skip: boolean('skip').notNull().default(false),
    /** Erasure tombstone (E-10): phone_enc and name nulled, hash kept as the legal record. */
    erasedAt: ts('erased_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('contacts_id_format', idFormat(t.id, 'cnt')),
    check('contacts_hash_format', sql`${t.phoneHash} ~ '^[0-9a-f]{64}$'`),
    check('contacts_enc_pair', sql`(${t.phoneEnc} is null) = (${t.phoneEncKid} is null)`),
    uniqueIndex('contacts_tenant_hash_uq').on(t.tenantId, t.phoneHash),
  ],
).enableRLS();

/**
 * Consent ledger — APPEND-ONLY (universal rule 1). A revocation is a new row with
 * action='revoke' pointing at the grant it revokes. "Is there consent?" is answered by the
 * `active_consents` view (migration 0001), never by mutating a row.
 */
export const consents = pgTable(
  'consents',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    phoneHash: phoneHash().notNull(),
    action: consentAction('action').notNull().default('grant'),
    /** For action='revoke': the grant being revoked. */
    grantId: text('grant_id'),
    purpose: purposeScope('purpose').notNull(),
    source: consentSource('source').notNull(),
    /** Region whose rules decided `expires_at` and whether `source` was acceptable. */
    recipientRegion: text('recipient_region').notNull(),
    /** URI of the evidence object (screenshot, form record, recording segment). */
    evidenceUri: text('evidence_uri'),
    wordingVersion: text('wording_version'),
    /** Order id / form id the consent was captured against. */
    externalRef: text('external_ref'),
    capturedAt: ts('captured_at').notNull(),
    /** Null = does not expire (US written, EU opt-in). India promotional: captured_at + 7d. */
    expiresAt: ts('expires_at'),
    /** Non-PII capture context: ip hash, user agent, checkbox id. */
    context: jsonb('context').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    check('consents_id_format', idFormat(t.id, 'con')),
    check('consents_revoke_has_grant', sql`(${t.action} = 'revoke') = (${t.grantId} is not null)`),
    index('consents_lookup_idx').on(t.tenantId, t.phoneHash, t.purpose, t.capturedAt),
    index('consents_grant_idx').on(t.grantId),
  ],
).enableRLS();

/**
 * Current-state suppressions. `tenant_id` NULL = GLOBAL (blocks every tenant — DNC page,
 * complaints, erasure). Lifting is an UPDATE of `lifted_at` only (trigger-enforced); history
 * of every add/lift goes to audit_log. Invariant 6: an active row blocks dispatch for every
 * purpose it covers, transactional included.
 */
export const suppressions = pgTable(
  'suppressions',
  {
    id: id(),
    tenantId: text('tenant_id').references(() => tenants.id),
    phoneHash: phoneHash().notNull(),
    purpose: purposeScope('purpose').notNull().default('all'),
    reason: suppressionReason('reason').notNull(),
    /** E-26 — wrong_number is scoped to one order; null = every order. */
    externalRef: text('external_ref'),
    /** Null = indefinite. Opt-out: +90d. Minor: +90d. */
    until: ts('until'),
    sourceAttemptId: text('source_attempt_id'),
    notes: text('notes'),
    createdBy: text('created_by'),
    liftedAt: ts('lifted_at'),
    liftedBy: text('lifted_by'),
    liftedReason: text('lifted_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    check('suppressions_id_format', idFormat(t.id, 'sup')),
    index('suppressions_lookup_idx').on(t.phoneHash, t.tenantId, t.purpose),
    index('suppressions_active_idx')
      .on(t.phoneHash)
      .where(sql`${t.liftedAt} is null`),
  ],
).enableRLS();

/** DND/NCPR scrub results, cached 24h (gate step 8). Global — a number's DND status is not tenant data. */
export const dndScrubCache = pgTable(
  'dnd_scrub_cache',
  {
    phoneHash: phoneHash().primaryKey(),
    region: text('region').notNull(),
    result: dndResult('result').notNull(),
    provider: text('provider').notNull(),
    checkedAt: ts('checked_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('dnd_scrub_expires_idx').on(t.expiresAt)],
);

/** Number-type lookup cache, 30 days (gate step 4, E-27). Global for the same reason. */
export const numberTypeCache = pgTable(
  'number_type_cache',
  {
    phoneHash: phoneHash().primaryKey(),
    phoneType: phoneType('phone_type').notNull(),
    provider: text('provider').notNull(),
    checkedAt: ts('checked_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('number_type_expires_idx').on(t.expiresAt)],
);

/**
 * DPDP / Shopify erasure (E-10, E-48). `tenant_id` NULL = a data principal's request that
 * fans out to every tenant holding the hash. Consents and suppressions survive erasure as the
 * legal record, PII-minimised (AGENTS §4).
 */
export const erasureRequests = pgTable(
  'erasure_requests',
  {
    id: id(),
    tenantId: text('tenant_id').references(() => tenants.id),
    phoneHash: phoneHash().notNull(),
    source: erasureSource('source').notNull(),
    /** Shopify customers/redact payload id, DNC page ticket, etc. Never the phone number. */
    externalRef: text('external_ref'),
    status: erasureStatus('status').notNull().default('requested'),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    /** TODO_LEGAL Q-06 — ERASURE_COMPLETION_TARGET_DAYS from request. */
    dueAt: ts('due_at').notNull(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    /** What was deleted where: recordings n, transcripts n, contacts tombstoned n, BQ rows n. */
    report: jsonb('report').notNull().default({}),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('erasure_requests_id_format', idFormat(t.id, 'era')),
    index('erasure_requests_status_idx').on(t.status, t.dueAt),
    index('erasure_requests_hash_idx').on(t.phoneHash),
  ],
).enableRLS();
