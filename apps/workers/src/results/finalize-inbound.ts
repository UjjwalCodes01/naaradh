import { eq, sql } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import {
  inboundConcurrencyKey,
  recordSpend,
  releaseConcurrency,
  suppress,
} from '@naaradh/compliance';
import type { EndReason, EngineEvent } from '@naaradh/engines-core';
import { audit, emitMerchantEvent, meterInboundCall } from '@naaradh/pipeline';
import { parseExtraction } from '@naaradh/scripts';
import { newId } from '@naaradh/shared';
import type { WorkerContext } from '../context.js';
import {
  scrubExtracted,
  suppressionFor,
  type AttemptRow,
  type FinalizeResult,
} from './finalize.js';

type Ended = Extract<EngineEvent, { type: 'call.ended' }>;
type Outcome = (typeof schema.outcome.enumValues)[number];

/** Outcome for an inbound call the engine gave no (valid) extraction for. */
const INBOUND_OUTCOME_BY_REASON: Readonly<Record<EndReason, Outcome>> = {
  completed: 'inconclusive',
  no_answer: 'abandoned',
  busy: 'abandoned',
  amd_hangup: 'abandoned',
  amd_message_left: 'abandoned',
  customer_hangup: 'inconclusive',
  max_duration: 'inconclusive',
  opt_out: 'opt_out',
  wrong_number: 'inconclusive',
  minor_answered: 'minor_answered',
  recording_refused: 'recording_refused',
  transfer_completed: 'transferred',
  transfer_failed: 'transfer_failed',
  cancelled: 'abandoned',
  invalid_number: 'failed',
  carrier_temp_fail: 'failed',
  engine_error: 'failed',
};

/** A caller who hangs up inside the greeting with nothing said did not have a conversation. */
const ABANDON_MAX_SEC = 10;

/**
 * call.ended for an INBOUND attempt (ADR-0006). Differs from outbound in exactly the places
 * the product differs:
 *
 *   outcome   inbound_support_v1 extraction; tickets on the call imply ticket_created
 *   billing   NEVER outcome-billed (invariant 11 untouched) — metered per connected minute
 *   slots     the inbound concurrency key, not the outbound one
 *   intents   none — there is no intent to retry or complete
 *
 * Suppressions still apply: an opt-out said on an inbound call stops OUTBOUND calls (E-95),
 * and a minor on the line is protected the same way in both directions.
 */
export async function finalizeInbound(
  ctx: WorkerContext,
  tx: Tx,
  tenantId: string,
  attempt: AttemptRow,
  ev: Ended,
  s: {
    answeredBy: 'human' | 'machine' | 'unknown' | null;
    disclosureMissing: boolean;
    costInr: number | null;
    now: Date;
  },
): Promise<FinalizeResult> {
  const { now } = s;
  let outcome: Outcome = INBOUND_OUTCOME_BY_REASON[ev.reason];
  let confidence = 0;
  let extracted: Record<string, unknown> = {};

  if (ev.extracted !== null) {
    const parsed = parseExtraction('inbound_support_v1', ev.extracted);
    if (
      parsed.ok &&
      (schema.outcome.enumValues as readonly string[]).includes(parsed.value.outcome)
    ) {
      outcome = parsed.value.outcome as Outcome;
      confidence = parsed.value.confidence;
      extracted = parsed.value;
    } else {
      outcome = 'inconclusive';
      await audit(tx, {
        tenantId,
        actorType: 'worker',
        action: 'outcome.extraction_invalid',
        targetType: 'call_attempt',
        targetId: attempt.id,
        after: {
          error: parsed.ok ? 'outcome_not_in_enum' : parsed.error,
          schema: 'inbound_support_v1',
        },
      });
    }
  }

  // What the tools actually did beats what the model summarised.
  const [tickets] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.supportTickets)
    .where(eq(schema.supportTickets.attemptId, attempt.id));
  const ticketCount = tickets?.n ?? 0;
  if (ticketCount > 0 && (outcome === 'inconclusive' || outcome === 'resolved'))
    outcome = 'ticket_created';
  if (
    ev.reason === 'opt_out' ||
    ev.reason === 'minor_answered' ||
    ev.reason === 'recording_refused'
  )
    outcome = INBOUND_OUTCOME_BY_REASON[ev.reason];
  if (ev.reason === 'transfer_completed' || ev.reason === 'transfer_failed')
    outcome = INBOUND_OUTCOME_BY_REASON[ev.reason];
  if (
    ev.reason === 'customer_hangup' &&
    ev.durationSec <= ABANDON_MAX_SEC &&
    ticketCount === 0 &&
    (ev.humanSpeechSec ?? 0) === 0
  )
    outcome = 'abandoned';
  if (s.disclosureMissing) outcome = 'inconclusive';

  const outcomeId = newId('outcome');
  await tx.insert(schema.callOutcomes).values({
    id: outcomeId,
    tenantId,
    attemptId: attempt.id,
    intentId: null,
    outcome,
    confidence: confidence.toFixed(2),
    extracted,
    extractionMethod: 'engine',
    billable: false,
    billableReason: 'inbound_minute_billed',
    superseded: false,
    writebackStatus: 'skipped',
  });
  await audit(tx, {
    tenantId,
    actorType: 'worker',
    action: 'outcome.final',
    targetType: 'call_outcome',
    targetId: outcomeId,
    after: {
      attempt_id: attempt.id,
      direction: 'inbound',
      outcome,
      confidence,
      tickets: ticketCount,
    },
  });

  // --- minutes (Q-17). A disclosure failure is our incident, not the merchant's bill. ------------------
  const connectedSec = s.disclosureMissing ? 0 : (ev.billableSec ?? ev.durationSec);
  const meter = await meterInboundCall(tx, {
    tenantId,
    attemptId: attempt.id,
    connectedSec,
    at: now,
    vendorCostMinor: ev.vendorCost?.minor ?? null,
    vendorCostCurrency: ev.vendorCost?.currency ?? null,
  });
  if (meter.minutes > 0 && !meter.duplicate) {
    await audit(tx, {
      tenantId,
      actorType: 'worker',
      action: 'billing.inbound_metered',
      targetType: 'call_attempt',
      targetId: attempt.id,
      after: {
        minutes: meter.minutes,
        included: meter.includedMinutes,
        overage: meter.overageMinutes,
        overage_minor: meter.overageMinor,
      },
    });
  }

  // --- side effects ----------------------------------------------------------------------------------------
  await releaseConcurrency(ctx.redis, inboundConcurrencyKey(tenantId), attempt.engine);
  // Every currency counts toward its own cap (P6): Retell's dollars, an Indian engine's rupees.
  if (ev.vendorCost !== null && /^[A-Z]{3}$/.test(ev.vendorCost.currency))
    await recordSpend(ctx.redis, attempt.engine, ev.vendorCost, now);

  const sup =
    outcome === 'opt_out' || outcome === 'minor_answered' ? suppressionFor(outcome) : null;
  if (sup !== null && attempt.phoneHash !== null) {
    const created = await suppress(tx, {
      scope: 'tenant',
      tenantId,
      phoneHash: attempt.phoneHash,
      purpose: sup.purpose,
      reason: sup.reason,
      at: now,
      sourceAttemptId: attempt.id,
      createdBy: `attempt:${attempt.id}`,
    });
    if (created.created) {
      await audit(tx, {
        tenantId,
        actorType: 'worker',
        action: 'suppression.created',
        targetType: 'suppression',
        targetId: created.id,
        after: {
          reason: sup.reason,
          until: created.until?.toISOString() ?? null,
          direction: 'inbound',
        },
      });
      await emitMerchantEvent(tx, tenantId, {
        type: 'suppression.created',
        eventId: `${created.id}:created`,
        at: now,
        data: {
          suppression_id: created.id,
          reason: sup.reason,
          until: created.until?.toISOString() ?? null,
          external_ref: null,
        },
      });
    }
  }

  await emitMerchantEvent(tx, tenantId, {
    type: 'call.completed',
    eventId: `${attempt.id}:completed`,
    at: now,
    data: {
      attempt_id: attempt.id,
      direction: 'inbound',
      intent_id: null,
      answered_by: s.answeredBy,
      end_reason: ev.reason,
      duration_sec: ev.durationSec,
      minutes: meter.minutes,
      external_refs: [],
    },
  });
  await emitMerchantEvent(tx, tenantId, {
    type: 'outcome.final',
    eventId: `${outcomeId}:final`,
    at: now,
    data: {
      outcome_id: outcomeId,
      attempt_id: attempt.id,
      direction: 'inbound',
      intent_id: null,
      outcome,
      confidence,
      billable: false,
      superseded: false,
      tickets: ticketCount,
      external_refs: [],
      extracted: scrubExtracted(extracted),
    },
  });

  const [row] = await tx
    .select({ status: schema.callAttempts.status })
    .from(schema.callAttempts)
    .where(eq(schema.callAttempts.id, attempt.id))
    .limit(1);
  return {
    attemptStatus: row?.status ?? 'ENDED',
    outcome,
    billable: false,
    intentStatus: null,
    nextAttemptAt: null,
  };
}
