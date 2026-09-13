import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, id, idFormat, minorUnits, phoneHash, ts, updatedAt } from './columns.js';
import { contacts } from './contacts.js';
import { callAttempts } from './calls.js';
import {
  agentActionStatus,
  knowledgeStatus,
  orderActionKind,
  orderActionStatus,
  orderSource,
  paymentKind,
  ticketCategory,
  ticketSource,
  ticketStatus,
} from './enums.js';
import { tenants } from './tenants.js';

/**
 * Inbound support (ADR-0006, SPEC §6.5). Everything the voice agent can know or do on a
 * customer's call has a table here, and every table is tenant-scoped under RLS.
 */

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * The merchant's knowledge base. The agent may state a policy only if an article (or a
 * pinned fact on the profile) says it — `search_knowledge` returns nothing else.
 *
 * Full-text search uses the 'simple' configuration on purpose: Hinglish and Hindi in Latin
 * script would be mangled by English stemming ("karna" → "karn"). 'simple' lowercases and
 * splits, which is what a mixed-language support FAQ needs. Title words weigh more than body.
 */
export const knowledgeArticles = pgTable(
  'knowledge_articles',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    title: text('title').notNull(),
    body: text('body').notNull(),
    locale: text('locale').notNull().default('en-IN'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: knowledgeStatus('status').notNull().default('draft'),
    search: tsvector('search').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(body, '')), 'B')`,
    ),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('knowledge_articles_id_format', idFormat(t.id, 'kba')),
    check('knowledge_articles_title_len', sql`char_length(${t.title}) between 1 and 200`),
    check('knowledge_articles_body_len', sql`char_length(${t.body}) between 1 and 8000`),
    index('knowledge_articles_search_idx').using('gin', t.search),
    index('knowledge_articles_tenant_idx').on(t.tenantId, t.status),
  ],
).enableRLS();

/**
 * Minimal order cache so the agent can answer "where is my order" in < 700 ms without a
 * Shopify round trip. Filled from webhooks already received (intents-consumer) or pushed via
 * the API by non-Shopify merchants. Deliberately NOT a copy of the order: no names, no
 * addresses, no line items — only what a status answer and identity checks need.
 *
 *   phone_hash    joins the caller (caller_id identity)
 *   pincode_hash  HMAC of the delivery pincode (knowledge identity, never spoken back)
 *   name_key      the order name normalised for spoken lookup: "#1001" / "1001" → "1001"
 */
export const orders = pgTable(
  'orders',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    source: orderSource('source').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    phoneHash: phoneHash(),
    pincodeHash: text('pincode_hash'),
    paymentKind: paymentKind('payment_kind').notNull().default('unknown'),
    financialStatus: text('financial_status'),
    fulfillmentStatus: text('fulfillment_status'),
    cancelledAt: ts('cancelled_at'),
    totalMinor: minorUnits('total_minor').notNull(),
    currency: text('currency').notNull(),
    itemSummary: text('item_summary').notNull().default(''),
    itemCount: integer('item_count').notNull().default(0),
    /** `{ company, number, url, status, estimated_delivery }` from fulfilment events. */
    tracking: jsonb('tracking'),
    placedAt: ts('placed_at').notNull(),
    /** Newest source-side update applied — older webhooks arriving late are ignored. */
    sourceUpdatedAt: ts('source_updated_at'),
    erasedAt: ts('erased_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('orders_id_format', idFormat(t.id, 'ord')),
    check('orders_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    uniqueIndex('orders_source_uq').on(t.tenantId, t.source, t.externalId),
    index('orders_phone_idx').on(t.tenantId, t.phoneHash, t.placedAt),
    index('orders_name_idx').on(t.tenantId, t.nameKey),
  ],
).enableRLS();

/**
 * What the merchant has to do because the agent may not (E-85, E-87, E-91, E-96): address
 * changes, refunds, prepaid cancellations, callbacks, questions the knowledge base could not
 * answer. `summary` is written by the agent but sanitised (E-72) and capped.
 */
export const supportTickets = pgTable(
  'support_tickets',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    attemptId: text('attempt_id').references(() => callAttempts.id),
    contactId: text('contact_id').references(() => contacts.id),
    orderId: text('order_id').references(() => orders.id),
    category: ticketCategory('category').notNull(),
    summary: text('summary').notNull(),
    callbackRequested: boolean('callback_requested').notNull().default(false),
    preferredTime: text('preferred_time'),
    status: ticketStatus('status').notNull().default('open'),
    source: ticketSource('source').notNull(),
    priority: smallint('priority').notNull().default(50),
    resolvedBy: text('resolved_by'),
    resolvedAt: ts('resolved_at'),
    resolution: text('resolution'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('support_tickets_id_format', idFormat(t.id, 'tkt')),
    check('support_tickets_summary_len', sql`char_length(${t.summary}) between 1 and 1000`),
    check(
      'support_tickets_resolved_pair',
      sql`(${t.status} = 'resolved') = (${t.resolvedAt} is not null)`,
    ),
    index('support_tickets_tenant_idx').on(t.tenantId, t.status, t.createdAt),
    index('support_tickets_attempt_idx').on(t.attemptId),
  ],
).enableRLS();

/**
 * APPEND-ONLY record of every tool call the voice agent made (invariant 18): what it asked
 * for (args, PII-scrubbed), what Naaradh decided, and what the agent was told. This is how
 * "did the agent ever tell anyone about an order that wasn't theirs?" gets answered.
 *
 * Two-step actions (cancellation, E-84) are two rows: step 1 has `status =
 * awaiting_confirmation` and the SHA-256 of a single-use token; step 2 references it via
 * `parent_action_id`. The partial unique index below makes a token spendable exactly once.
 */
export const agentActions = pgTable(
  'agent_actions',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => callAttempts.id),
    tool: text('tool').notNull(),
    args: jsonb('args').notNull().default({}),
    status: agentActionStatus('status').notNull(),
    result: jsonb('result').notNull().default({}),
    orderId: text('order_id').references(() => orders.id),
    ticketId: text('ticket_id').references(() => supportTickets.id),
    parentActionId: text('parent_action_id'),
    /** The engine's id for this invocation; a retried invocation replays the stored result. */
    toolCallId: text('tool_call_id'),
    confirmTokenHash: text('confirm_token_hash'),
    tokenExpiresAt: ts('token_expires_at'),
    latencyMs: integer('latency_ms'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [
    check('agent_actions_id_format', idFormat(t.id, 'act')),
    check(
      'agent_actions_token_pair',
      sql`(${t.confirmTokenHash} is null) = (${t.tokenExpiresAt} is null)`,
    ),
    uniqueIndex('agent_actions_token_spent_once')
      .on(t.parentActionId)
      .where(sql`${t.parentActionId} is not null`),
    uniqueIndex('agent_actions_tool_call_uq')
      .on(t.attemptId, t.toolCallId)
      .where(sql`${t.toolCallId} is not null`),
    index('agent_actions_attempt_idx').on(t.attemptId, t.at),
    index('agent_actions_tenant_idx').on(t.tenantId, t.at),
  ],
).enableRLS();

/**
 * Work the `actions` worker executes against the merchant's store after an agent action was
 * approved (e.g. a two-step cancellation). Mutable queue rows — the immutable record of the
 * decision is the agent_actions row this points to.
 */
export const orderActions = pgTable(
  'order_actions',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    agentActionId: text('agent_action_id')
      .notNull()
      .references(() => agentActions.id),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    kind: orderActionKind('kind').notNull(),
    status: orderActionStatus('status').notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at'),
    lastError: text('last_error'),
    doneAt: ts('done_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('order_actions_id_format', idFormat(t.id, 'oac')),
    uniqueIndex('order_actions_agent_action_uq').on(t.agentActionId),
    index('order_actions_due_idx')
      .on(t.status, t.nextAttemptAt)
      .where(sql`${t.status} in ('pending','failed')`),
  ],
).enableRLS();
