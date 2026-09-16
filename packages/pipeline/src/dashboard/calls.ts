import { and, asc, desc, eq, inArray, lt, or, sql, type Column, type SQL } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import { NaaradhError } from '@naaradh/shared';
import { audit } from '../audit.js';
import { auditActor, type Actor } from '../admin/actor.js';
import {
  explainAgentAction,
  explainGate,
  explainIdentity,
  explainIntentStatus,
  explainOutcome,
  explainWriteback,
  type Explained,
} from './explain.js';

/**
 * What the dashboards show about calls (P2-WEB-1). Two lists, because merchants think about
 * them differently: outbound is per ORDER (an intent, with its gate verdict and attempts);
 * inbound is per CALL (a customer rang the support line). Tenant-scoped reads under RLS.
 *
 * Customer numbers appear masked only (`+91 98xxx xx123`). Reveal is not offered: it needs the
 * customer private key, which no merchant-facing service holds (AGENTS §4, ADR-0009).
 */

export const PAGE_SIZE = 50;

/** Opaque keyset cursor over (created_at desc, id desc). */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (cursor === undefined || cursor === '') return null;
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (iso === undefined || id === undefined || !/^[a-z]{3}_[0-9A-Z]{26}$/.test(id)) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : { at, id };
}

function keyset(cursor: { at: Date; id: string } | null, at: Column, id: Column): SQL {
  if (cursor === null) return sql`true`;
  return or(lt(at, cursor.at), and(eq(at, cursor.at), lt(id, cursor.id))) ?? sql`true`;
}

// ---- outbound: orders --------------------------------------------------------------------------

export type OutboundFilter = 'all' | 'gated' | 'active' | 'completed' | 'needs_action';

export interface OutboundRow {
  readonly id: string;
  readonly orderRef: string;
  readonly useCase: string;
  readonly status: Explained & { readonly code: string };
  readonly gated: { readonly code: string; readonly title: string; readonly hint: string } | null;
  readonly outcome: (Explained & { readonly code: string }) | null;
  readonly billable: boolean | null;
  readonly attempts: number;
  readonly valueMinor: number | null;
  readonly currency: string | null;
  readonly phone: string;
  readonly createdAt: Date;
}

const latestOutcome = sql<
  string | null
>`(select o.outcome from call_outcomes o where o.intent_id = ${schema.callIntents.id} order by o.created_at desc limit 1)`;
const latestBillable = sql<
  boolean | null
>`(select o.billable from call_outcomes o where o.intent_id = ${schema.callIntents.id} order by o.created_at desc limit 1)`;

export async function listOutbound(
  tx: Tx,
  tenantId: string,
  options: {
    readonly filter?: OutboundFilter;
    readonly orderRef?: string;
    readonly cursor?: string;
    readonly limit?: number;
  } = {},
): Promise<{ rows: OutboundRow[]; next: string | null }> {
  const limit = Math.min(options.limit ?? PAGE_SIZE, 200);
  const filter = options.filter ?? 'all';
  const statusCond: SQL =
    filter === 'gated'
      ? eq(schema.callIntents.status, 'GATED')
      : filter === 'active'
        ? inArray(schema.callIntents.status, [
            'CREATED',
            'SCHEDULED',
            'DISPATCHING',
            'IN_PROGRESS',
            'RETRY_SCHEDULED',
          ])
        : filter === 'completed'
          ? inArray(schema.callIntents.status, ['COMPLETED', 'EXHAUSTED', 'EXPIRED', 'CANCELLED'])
          : filter === 'needs_action'
            ? sql`exists (select 1 from call_outcomes o where o.intent_id = ${schema.callIntents.id} and (o.writeback_status in ('failed','needs_review') or o.outcome in ('needs_merchant_action','callback_requested','convert_to_prepaid_requested')))`
            : sql`true`;
  const rows = await tx
    .select({
      id: schema.callIntents.id,
      orderRef: schema.callIntents.externalRef,
      useCase: schema.callIntents.useCase,
      status: schema.callIntents.status,
      gatedReason: schema.callIntents.gatedReason,
      attempts: schema.callIntents.attemptsCount,
      valueMinor: schema.callIntents.valuePaise,
      currency: schema.callIntents.currency,
      createdAt: schema.callIntents.createdAt,
      phone: schema.contacts.phoneMasked,
      outcome: latestOutcome,
      billable: latestBillable,
    })
    .from(schema.callIntents)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.callIntents.contactId))
    .where(
      and(
        eq(schema.callIntents.tenantId, tenantId),
        eq(schema.callIntents.direction, 'outbound'),
        statusCond,
        options.orderRef === undefined || options.orderRef.trim() === ''
          ? sql`true`
          : sql`${options.orderRef.trim()} = any(${schema.callIntents.externalRefs})`,
        keyset(decodeCursor(options.cursor), schema.callIntents.createdAt, schema.callIntents.id),
      ),
    )
    .orderBy(desc(schema.callIntents.createdAt), desc(schema.callIntents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map((r) => {
      const gate = explainGate(r.gatedReason);
      return {
        id: r.id,
        orderRef: r.orderRef,
        useCase: r.useCase,
        status: { code: r.status, ...explainIntentStatus(r.status) },
        gated:
          r.status === 'GATED' && gate !== null && r.gatedReason !== null
            ? { code: r.gatedReason, title: gate.title, hint: gate.hint }
            : null,
        outcome: r.outcome === null ? null : { code: r.outcome, ...explainOutcome(r.outcome) },
        billable: r.billable,
        attempts: r.attempts,
        valueMinor: r.valueMinor,
        currency: r.currency,
        phone: r.phone,
        createdAt: r.createdAt,
      };
    }),
    next: rows.length > limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export interface GateStepView {
  readonly step: number;
  readonly name: string;
  readonly ok: boolean;
  readonly reason: string | null;
}

function gateSteps(trace: unknown): GateStepView[] {
  if (!Array.isArray(trace)) return [];
  return trace.flatMap((s: unknown) => {
    if (s === null || typeof s !== 'object') return [];
    const o = s as Record<string, unknown>;
    return [
      {
        step: typeof o['step'] === 'number' ? o['step'] : 0,
        name: typeof o['name'] === 'string' ? o['name'] : 'check',
        ok: o['ok'] === true,
        reason: typeof o['reason'] === 'string' ? o['reason'] : null,
      },
    ];
  });
}

export interface AttemptView {
  readonly id: string;
  readonly attemptNo: number;
  readonly status: string;
  readonly startedAt: Date | null;
  readonly answeredAt: Date | null;
  readonly endedAt: Date | null;
  readonly answeredBy: string | null;
  readonly endReason: string | null;
  readonly durationSec: number | null;
  readonly aiDisclosedAt: Date | null;
  readonly recordingDisclosedAt: Date | null;
  readonly hasRecording: boolean;
  readonly hasTranscript: boolean;
  readonly mediaPurgedAt: Date | null;
  /** ADR-0010 §4: the DLT content template a promotional call ran under. */
  readonly dltTemplateId: string | null;
}

export interface OutcomeView {
  readonly id: string;
  readonly attemptId: string;
  readonly outcome: Explained & { readonly code: string };
  readonly confidence: number;
  readonly details: Readonly<Record<string, unknown>>;
  readonly billable: boolean;
  readonly billableReason: string;
  readonly billedAt: Date | null;
  readonly chargedMinor: number | null;
  readonly chargeCurrency: string | null;
  readonly writeback: Explained & { readonly code: string; readonly error: string | null };
  readonly dispute: { readonly id: string; readonly status: string } | null;
}

/**
 * Extraction fields a merchant may see on the order page — decisions, not free text. Free
 * text the customer said (a new address) is shown only as "needs review" (Q-19).
 */
const DETAIL_KEYS = [
  'outcome',
  'cancel_reason',
  'reschedule_date',
  'quantity_change',
  'pincode_confirmed',
  'category',
] as const;

function outcomeDetails(extracted: unknown): Record<string, unknown> {
  if (extracted === null || typeof extracted !== 'object') return {};
  const e = extracted as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of DETAIL_KEYS) if (e[k] !== undefined && e[k] !== null) out[k] = e[k];
  return out;
}

async function outcomesFor(tx: Tx, tenantId: string, attemptIds: string[]): Promise<OutcomeView[]> {
  if (attemptIds.length === 0) return [];
  const rows = await tx
    .select({
      id: schema.callOutcomes.id,
      attemptId: schema.callOutcomes.attemptId,
      outcome: schema.callOutcomes.outcome,
      confidence: schema.callOutcomes.confidence,
      extracted: schema.callOutcomes.extracted,
      billable: schema.callOutcomes.billable,
      billableReason: schema.callOutcomes.billableReason,
      billedAt: schema.callOutcomes.billedAt,
      writebackStatus: schema.callOutcomes.writebackStatus,
      writebackError: schema.callOutcomes.writebackError,
      charged: schema.billingLedger.totalMinor,
      chargeCurrency: schema.billingLedger.currency,
      disputeId: schema.outcomeDisputes.id,
      disputeStatus: schema.outcomeDisputes.status,
    })
    .from(schema.callOutcomes)
    .leftJoin(
      schema.billingLedger,
      eq(schema.billingLedger.id, schema.callOutcomes.billingLedgerId),
    )
    .leftJoin(schema.outcomeDisputes, eq(schema.outcomeDisputes.outcomeId, schema.callOutcomes.id))
    .where(
      and(
        eq(schema.callOutcomes.tenantId, tenantId),
        inArray(schema.callOutcomes.attemptId, attemptIds),
      ),
    )
    .orderBy(asc(schema.callOutcomes.createdAt));
  return rows.map((r) => ({
    id: r.id,
    attemptId: r.attemptId,
    outcome: { code: r.outcome, ...explainOutcome(r.outcome) },
    confidence: Number(r.confidence),
    details: outcomeDetails(r.extracted),
    billable: r.billable,
    billableReason: r.billableReason,
    billedAt: r.billedAt,
    chargedMinor: r.charged === null ? null : Number(r.charged),
    chargeCurrency: r.chargeCurrency,
    writeback: {
      code: r.writebackStatus,
      error: r.writebackError,
      ...explainWriteback(r.writebackStatus),
    },
    dispute: r.disputeId === null ? null : { id: r.disputeId, status: r.disputeStatus ?? 'open' },
  }));
}

const attemptColumns = {
  id: schema.callAttempts.id,
  attemptNo: schema.callAttempts.attemptNo,
  status: schema.callAttempts.status,
  startedAt: schema.callAttempts.startedAt,
  answeredAt: schema.callAttempts.answeredAt,
  endedAt: schema.callAttempts.endedAt,
  answeredBy: schema.callAttempts.answeredBy,
  endReason: schema.callAttempts.endReason,
  durationSec: schema.callAttempts.durationSec,
  aiDisclosedAt: schema.callAttempts.aiDisclosedAt,
  recordingDisclosedAt: schema.callAttempts.recordingDisclosedAt,
  recordingUri: schema.callAttempts.recordingUri,
  transcriptUri: schema.callAttempts.transcriptUri,
  mediaPurgedAt: schema.callAttempts.mediaPurgedAt,
  dltTemplateId: schema.callAttempts.dltTemplateId,
};

function attemptView(a: {
  id: string;
  attemptNo: number;
  status: string;
  startedAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  answeredBy: string | null;
  endReason: string | null;
  durationSec: number | null;
  aiDisclosedAt: Date | null;
  recordingDisclosedAt: Date | null;
  recordingUri: string | null;
  transcriptUri: string | null;
  mediaPurgedAt: Date | null;
  dltTemplateId: string | null;
}): AttemptView {
  return {
    id: a.id,
    attemptNo: a.attemptNo,
    status: a.status,
    startedAt: a.startedAt,
    answeredAt: a.answeredAt,
    endedAt: a.endedAt,
    answeredBy: a.answeredBy,
    endReason: a.endReason,
    durationSec: a.durationSec,
    aiDisclosedAt: a.aiDisclosedAt,
    recordingDisclosedAt: a.recordingDisclosedAt,
    hasRecording: a.recordingUri !== null,
    hasTranscript: a.transcriptUri !== null,
    mediaPurgedAt: a.mediaPurgedAt,
    dltTemplateId: a.dltTemplateId,
  };
}

export interface OutboundDetail {
  readonly id: string;
  readonly orderRef: string;
  readonly orderRefs: string[];
  readonly useCase: string;
  readonly purpose: string;
  readonly status: Explained & { readonly code: string };
  readonly gate: {
    readonly code: string;
    readonly title: string;
    readonly explanation: string;
    readonly hint: string;
  } | null;
  readonly steps: GateStepView[];
  readonly phone: string;
  readonly customerName: string | null;
  readonly valueMinor: number | null;
  readonly currency: string | null;
  readonly eventTs: Date;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly locale: string;
  readonly cancelReason: string | null;
  readonly createdAt: Date;
  readonly attempts: AttemptView[];
  readonly outcomes: OutcomeView[];
}

export async function outboundDetail(
  tx: Tx,
  tenantId: string,
  intentId: string,
): Promise<OutboundDetail> {
  const [i] = await tx
    .select({
      id: schema.callIntents.id,
      orderRef: schema.callIntents.externalRef,
      orderRefs: schema.callIntents.externalRefs,
      useCase: schema.callIntents.useCase,
      purpose: schema.callIntents.purpose,
      status: schema.callIntents.status,
      gatedReason: schema.callIntents.gatedReason,
      gateTrace: schema.callIntents.gateTrace,
      variables: schema.callIntents.variables,
      valueMinor: schema.callIntents.valuePaise,
      currency: schema.callIntents.currency,
      eventTs: schema.callIntents.eventTs,
      notBefore: schema.callIntents.notBefore,
      notAfter: schema.callIntents.notAfter,
      locale: schema.callIntents.locale,
      cancelReason: schema.callIntents.cancelReason,
      createdAt: schema.callIntents.createdAt,
      phone: schema.contacts.phoneMasked,
      erasedAt: schema.contacts.erasedAt,
    })
    .from(schema.callIntents)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.callIntents.contactId))
    .where(and(eq(schema.callIntents.tenantId, tenantId), eq(schema.callIntents.id, intentId)))
    .limit(1);
  if (i === undefined) throw new NaaradhError('NOT_FOUND', 'order call not found');
  const attempts = await tx
    .select(attemptColumns)
    .from(schema.callAttempts)
    .where(and(eq(schema.callAttempts.tenantId, tenantId), eq(schema.callAttempts.intentId, i.id)))
    .orderBy(asc(schema.callAttempts.attemptNo));
  const gate = explainGate(i.gatedReason);
  const vars = (i.variables ?? {}) as Record<string, unknown>;
  const name = typeof vars['customer_name'] === 'string' ? vars['customer_name'] : null;
  return {
    id: i.id,
    orderRef: i.orderRef,
    orderRefs: i.orderRefs,
    useCase: i.useCase,
    purpose: i.purpose,
    status: { code: i.status, ...explainIntentStatus(i.status) },
    gate:
      gate === null || i.gatedReason === null
        ? null
        : {
            code: i.gatedReason,
            title: gate.title,
            explanation: gate.explanation,
            hint: gate.hint,
          },
    steps: gateSteps(i.gateTrace),
    phone: i.phone,
    // An erased contact's name is gone everywhere (E-10), including the intent's variables.
    customerName: i.erasedAt === null ? name : null,
    valueMinor: i.valueMinor,
    currency: i.currency,
    eventTs: i.eventTs,
    notBefore: i.notBefore,
    notAfter: i.notAfter,
    locale: i.locale,
    cancelReason: i.cancelReason,
    createdAt: i.createdAt,
    attempts: attempts.map(attemptView),
    outcomes: await outcomesFor(
      tx,
      tenantId,
      attempts.map((a) => a.id),
    ),
  };
}

// ---- inbound: support calls ------------------------------------------------------------------------

export interface InboundRow {
  readonly id: string;
  readonly caller: string;
  readonly identity: Explained & { readonly code: string };
  readonly status: string;
  readonly outcome: (Explained & { readonly code: string }) | null;
  readonly durationSec: number | null;
  readonly transferred: boolean;
  readonly tickets: number;
  readonly startedAt: Date | null;
  readonly createdAt: Date;
}

export async function listInbound(
  tx: Tx,
  tenantId: string,
  options: { readonly cursor?: string; readonly limit?: number } = {},
): Promise<{ rows: InboundRow[]; next: string | null }> {
  const limit = Math.min(options.limit ?? PAGE_SIZE, 200);
  const rows = await tx
    .select({
      id: schema.callAttempts.id,
      withheld: schema.callAttempts.callerWithheld,
      phone: schema.contacts.phoneMasked,
      identity: schema.callAttempts.callerVerification,
      status: schema.callAttempts.status,
      durationSec: schema.callAttempts.durationSec,
      transferResult: schema.callAttempts.transferResult,
      startedAt: schema.callAttempts.startedAt,
      createdAt: schema.callAttempts.createdAt,
      outcome: schema.callOutcomes.outcome,
      tickets: sql<number>`(select count(*)::int from support_tickets t where t.attempt_id = ${schema.callAttempts.id})`,
    })
    .from(schema.callAttempts)
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.callAttempts.contactId))
    .leftJoin(schema.callOutcomes, eq(schema.callOutcomes.attemptId, schema.callAttempts.id))
    .where(
      and(
        eq(schema.callAttempts.tenantId, tenantId),
        eq(schema.callAttempts.direction, 'inbound'),
        keyset(decodeCursor(options.cursor), schema.callAttempts.createdAt, schema.callAttempts.id),
      ),
    )
    .orderBy(desc(schema.callAttempts.createdAt), desc(schema.callAttempts.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map((r) => ({
      id: r.id,
      caller: r.withheld ? 'Withheld' : (r.phone ?? 'Unknown'),
      identity: { code: r.identity, ...explainIdentity(r.identity) },
      status: r.status,
      outcome: r.outcome === null ? null : { code: r.outcome, ...explainOutcome(r.outcome) },
      durationSec: r.durationSec,
      transferred: r.transferResult === 'completed',
      tickets: r.tickets,
      startedAt: r.startedAt,
      createdAt: r.createdAt,
    })),
    next: rows.length > limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export interface AgentActionView {
  readonly id: string;
  readonly tool: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly orderId: string | null;
  readonly ticketId: string | null;
  readonly latencyMs: number | null;
  readonly at: Date;
}

export interface InboundDetail {
  readonly attempt: AttemptView;
  readonly caller: string;
  readonly identity: Explained & { readonly code: string };
  readonly admission: GateStepView[];
  readonly transferResult: string | null;
  readonly actions: AgentActionView[];
  readonly tickets: {
    readonly id: string;
    readonly category: string;
    readonly summary: string;
    readonly status: string;
  }[];
  readonly outcome: OutcomeView | null;
}

export async function inboundDetail(
  tx: Tx,
  tenantId: string,
  attemptId: string,
): Promise<InboundDetail> {
  const [a] = await tx
    .select({
      ...attemptColumns,
      withheld: schema.callAttempts.callerWithheld,
      phone: schema.contacts.phoneMasked,
      identity: schema.callAttempts.callerVerification,
      admission: schema.callAttempts.admissionTrace,
      transferResult: schema.callAttempts.transferResult,
      direction: schema.callAttempts.direction,
    })
    .from(schema.callAttempts)
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.callAttempts.contactId))
    .where(and(eq(schema.callAttempts.tenantId, tenantId), eq(schema.callAttempts.id, attemptId)))
    .limit(1);
  if (a === undefined || a.direction !== 'inbound')
    throw new NaaradhError('NOT_FOUND', 'support call not found');
  const actions = await tx
    .select({
      id: schema.agentActions.id,
      tool: schema.agentActions.tool,
      status: schema.agentActions.status,
      orderId: schema.agentActions.orderId,
      ticketId: schema.agentActions.ticketId,
      latencyMs: schema.agentActions.latencyMs,
      at: schema.agentActions.at,
    })
    .from(schema.agentActions)
    .where(and(eq(schema.agentActions.tenantId, tenantId), eq(schema.agentActions.attemptId, a.id)))
    .orderBy(asc(schema.agentActions.at), asc(schema.agentActions.id));
  const tickets = await tx
    .select({
      id: schema.supportTickets.id,
      category: schema.supportTickets.category,
      summary: schema.supportTickets.summary,
      status: schema.supportTickets.status,
    })
    .from(schema.supportTickets)
    .where(
      and(eq(schema.supportTickets.tenantId, tenantId), eq(schema.supportTickets.attemptId, a.id)),
    );
  const [outcome] = await outcomesFor(tx, tenantId, [a.id]);
  return {
    attempt: attemptView(a),
    caller: a.withheld ? 'Withheld' : (a.phone ?? 'Unknown'),
    identity: { code: a.identity, ...explainIdentity(a.identity) },
    admission: gateSteps(a.admission),
    transferResult: a.transferResult,
    actions: actions.map((x) => ({ ...x, statusLabel: explainAgentAction(x.status) })),
    tickets,
    outcome: outcome ?? null,
  };
}

// ---- recordings and transcripts (E-74: every access is audited) --------------------------------------

/**
 * The storage URI of a call's recording or transcript, for the caller to sign or fetch. Writes
 * the access to audit_log first — the merchant's access log shows who listened to what.
 */
export async function accessMedia(
  tx: Tx,
  actor: Actor,
  attemptId: string,
  kind: 'recording' | 'transcript',
): Promise<string> {
  const [row] = await tx
    .select({
      id: schema.callAttempts.id,
      recordingUri: schema.callAttempts.recordingUri,
      transcriptUri: schema.callAttempts.transcriptUri,
    })
    .from(schema.callAttempts)
    .where(
      and(eq(schema.callAttempts.tenantId, actor.tenantId), eq(schema.callAttempts.id, attemptId)),
    )
    .limit(1);
  if (row === undefined) throw new NaaradhError('NOT_FOUND', 'call not found');
  const uri = kind === 'recording' ? row.recordingUri : row.transcriptUri;
  if (uri === null) throw new NaaradhError('NOT_FOUND', `no ${kind} for this call`);
  await audit(tx, {
    ...auditActor(actor),
    action: kind === 'recording' ? 'recording.accessed' : 'transcript.accessed',
    targetType: 'call_attempt',
    targetId: row.id,
  });
  return uri;
}
