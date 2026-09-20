import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, id, idFormat, minorUnits, phoneHash, ts, updatedAt } from './columns.js';
import { callAttempts, callIntents, callOutcomes } from './calls.js';
import { contacts } from './contacts.js';
import { checkoutStatus, qaReviewStatus, useCaseKind } from './enums.js';
import { orders } from './inbound.js';
import { tenants } from './tenants.js';

/**
 * ADR-0010 — abandoned checkouts, cached then swept. One row per (tenant, source, checkout).
 * Newest `source_updated_at` wins; the sweep turns an idle, consented, phone-bearing checkout
 * into exactly one `abandoned_cart` intent. Deliberately holds NO name, email, address or
 * recovery URL: a phone hash, a contact link, the cart summary and value, timestamps.
 */
export const checkouts = pgTable(
  'checkouts',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** `shopify` today; the abandoned-cart source abstraction (SPEC §8.8) for OCC providers later. */
    source: text('source').notNull(),
    /** Shopify checkout token. */
    externalId: text('external_id').notNull(),
    phoneHash: phoneHash(),
    contactId: text('contact_id').references(() => contacts.id),
    recipientRegion: text('recipient_region'),
    valueMinor: minorUnits('value_minor').notNull().default(0),
    currency: text('currency').notNull(),
    itemSummary: text('item_summary').notNull().default(''),
    itemCount: integer('item_count').notNull().default(0),
    /** Wording version of our consent checkbox as last seen on this checkout (null = not ticked). */
    consentWording: text('consent_wording'),
    status: checkoutStatus('status').notNull().default('open'),
    skipReason: text('skip_reason'),
    sourceCreatedAt: ts('source_created_at').notNull(),
    sourceUpdatedAt: ts('source_updated_at').notNull(),
    completedAt: ts('completed_at'),
    /** The order that ended the abandonment (same checkout or same phone). */
    orderId: text('order_id').references(() => orders.id),
    intentId: text('intent_id').references(() => callIntents.id),
    sweptAt: ts('swept_at'),
    erasedAt: ts('erased_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('checkouts_id_format', idFormat(t.id, 'chk')),
    check('checkouts_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('checkouts_value_nonneg', sql`${t.valueMinor} >= 0`),
    uniqueIndex('checkouts_source_uq').on(t.tenantId, t.source, t.externalId),
    index('checkouts_sweep_idx')
      .on(t.sourceUpdatedAt)
      .where(sql`${t.status} = 'open'`),
    index('checkouts_phone_idx').on(t.tenantId, t.phoneHash, t.sourceCreatedAt),
  ],
).enableRLS();

/**
 * ADR-0010 §9 — an order credited to a call (last touch). Measured, NOT billed: invariant 11's
 * billable set is unchanged until a pricing decision is recorded. One row per (tenant, order,
 * use case); `reversed_at` when the order is later cancelled (E-118).
 */
export const attributions = pgTable(
  'attributions',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    useCase: useCaseKind('use_case').notNull(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    intentId: text('intent_id')
      .notNull()
      .references(() => callIntents.id),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => callAttempts.id),
    outcomeId: text('outcome_id').references(() => callOutcomes.id),
    /** `checkout` (same checkout token) or `phone` (same phone within the window). */
    matchedBy: text('matched_by').notNull(),
    valueMinor: minorUnits('value_minor').notNull(),
    currency: text('currency').notNull(),
    windowHours: smallint('window_hours').notNull(),
    callEndedAt: ts('call_ended_at').notNull(),
    orderPlacedAt: ts('order_placed_at').notNull(),
    reversedAt: ts('reversed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    check('attributions_id_format', idFormat(t.id, 'atr')),
    check('attributions_matched_by', sql`${t.matchedBy} in ('checkout', 'phone')`),
    check('attributions_order_after_call', sql`${t.orderPlacedAt} >= ${t.callEndedAt}`),
    uniqueIndex('attributions_order_uq').on(t.tenantId, t.orderId, t.useCase),
    index('attributions_period_idx').on(t.tenantId, t.useCase, t.orderPlacedAt),
  ],
).enableRLS();

/**
 * ADR-0010 §11 / P4-OPS-1 — weekly recording QA. Staff-only: RLS forced with no app policy,
 * written and read by the service role (sampling worker, console).
 */
export const qaReviews = pgTable(
  'qa_reviews',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => callAttempts.id),
    /** ISO week the call belongs to, e.g. `2026-W37`. */
    week: text('week').notNull(),
    status: qaReviewStatus('status').notNull().default('pending'),
    sampledAt: ts('sampled_at').notNull(),
    reviewer: text('reviewer'),
    reviewedAt: ts('reviewed_at'),
    /** Rubric: disclosure_ok, script_adherence 1–5, extraction_correct, tone 1–5, prohibited_content. */
    scores: jsonb('scores'),
    extractionCorrect: boolean('extraction_correct'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('qa_reviews_id_format', idFormat(t.id, 'qar')),
    check('qa_reviews_week_format', sql`${t.week} ~ '^[0-9]{4}-W[0-9]{2}$'`),
    check(
      'qa_reviews_done_has_review',
      sql`${t.status} <> 'done' or (${t.reviewedAt} is not null and ${t.reviewer} is not null and ${t.scores} is not null)`,
    ),
    uniqueIndex('qa_reviews_attempt_uq').on(t.attemptId),
    index('qa_reviews_queue_idx').on(t.status, t.sampledAt),
  ],
).enableRLS();
