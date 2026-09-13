import { and, eq } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import {
  isBillable,
  isRetryEligible,
  nextRetryAt,
  recordSpend,
  releaseConcurrency,
  suppress,
  windowFor,
} from '@naaradh/compliance';
import type { EngineEvent, EndReason } from '@naaradh/engines-core';
import { audit, emitMerchantEvent, meterOutcome } from '@naaradh/pipeline';
import { parseExtraction } from '@naaradh/scripts';
import { newId } from '@naaradh/shared';
import type { WorkerContext } from '../context.js';
import { finalizeInbound } from './finalize-inbound.js';

type Ended = Extract<EngineEvent, { type: 'call.ended' }>;

export interface AttemptRow {
  readonly id: string;
  readonly intentId: string | null;
  readonly direction: 'inbound' | 'outbound';
  /** Always set for outbound (call_attempts_party_known); inbound may lack both (E-80). */
  readonly contactId: string | null;
  readonly phoneHash: string | null;
  readonly purpose: 'transactional' | 'service' | 'promotional';
  readonly externalRef: string | null;
  readonly attemptNo: number;
  readonly engine: string;
  readonly status: string;
  readonly answeredBy: 'human' | 'machine' | 'unknown' | null;
  readonly answeredAt: Date | null;
  readonly aiDisclosedAt: Date | null;
  readonly recordingDisclosedAt: Date | null;
  readonly scriptId: string | null;
}

const ATTEMPT_STATUS_BY_REASON: Readonly<
  Record<EndReason, (typeof schema.attemptStatus.enumValues)[number]>
> = {
  completed: 'ENDED',
  no_answer: 'NO_ANSWER',
  busy: 'BUSY',
  amd_hangup: 'AMD_HANGUP',
  amd_message_left: 'AMD_MESSAGE_LEFT',
  customer_hangup: 'ENDED',
  max_duration: 'ENDED',
  opt_out: 'ENDED',
  wrong_number: 'ENDED',
  minor_answered: 'ENDED',
  recording_refused: 'ENDED',
  transfer_completed: 'ENDED',
  transfer_failed: 'ENDED',
  cancelled: 'CANCELLED',
  invalid_number: 'FAILED',
  carrier_temp_fail: 'FAILED',
  engine_error: 'FAILED',
};

/** Outcome when the engine gave no (valid) extraction. */
const OUTCOME_BY_REASON: Readonly<Record<EndReason, (typeof schema.outcome.enumValues)[number]>> = {
  completed: 'inconclusive',
  no_answer: 'no_answer',
  busy: 'busy',
  amd_hangup: 'voicemail',
  amd_message_left: 'voicemail',
  customer_hangup: 'inconclusive',
  max_duration: 'inconclusive',
  opt_out: 'opt_out',
  wrong_number: 'wrong_number',
  minor_answered: 'minor_answered',
  recording_refused: 'recording_refused',
  transfer_completed: 'transferred',
  transfer_failed: 'callback_requested',
  cancelled: 'outcome_superseded',
  invalid_number: 'failed',
  carrier_temp_fail: 'failed',
  engine_error: 'failed',
};

/** Which outcomes carry a protective suppression (E-03, E-11, E-26, E-12). */
export function suppressionFor(outcome: string): {
  reason: 'opt_out' | 'minor' | 'wrong_number' | 'recording_refused';
  purpose: 'all';
  scopedToOrder: boolean;
} | null {
  switch (outcome) {
    case 'opt_out':
      return { reason: 'opt_out', purpose: 'all', scopedToOrder: false };
    case 'minor_answered':
      return { reason: 'minor', purpose: 'all', scopedToOrder: false };
    case 'wrong_number':
      return { reason: 'wrong_number', purpose: 'all', scopedToOrder: true };
    case 'recording_refused':
      return { reason: 'recording_refused', purpose: 'all', scopedToOrder: true };
    default:
      return null;
  }
}

export interface FinalizeResult {
  readonly attemptStatus: string;
  readonly outcome: string;
  readonly billable: boolean;
  readonly intentStatus: string | null;
  readonly nextAttemptAt: Date | null;
}

/**
 * call.ended → attempt terminal state, outcome, billing, side-effects, retry/complete.
 * Runs inside the tenant transaction the results-consumer opened. Idempotent: a second
 * ended event for an attempt that already has an outcome is a no-op.
 */
export async function finalizeAttempt(
  ctx: WorkerContext,
  tx: Tx,
  tenantId: string,
  attempt: AttemptRow,
  ev: Ended,
  _opts: { signatureValid: boolean },
): Promise<FinalizeResult | null> {
  const [existing] = await tx
    .select({ id: schema.callOutcomes.id, outcome: schema.callOutcomes.outcome })
    .from(schema.callOutcomes)
    .where(eq(schema.callOutcomes.attemptId, attempt.id))
    .limit(1);
  if (existing !== undefined) return null;

  const now = ctx.clock.now();
  const answeredBy = attempt.answeredBy ?? ev.answeredBy;
  const intent =
    attempt.intentId === null
      ? null
      : ((
          await tx
            .select({
              id: schema.callIntents.id,
              useCase: schema.callIntents.useCase,
              purpose: schema.callIntents.purpose,
              notAfter: schema.callIntents.notAfter,
              cancelledAt: schema.callIntents.cancelledAt,
              externalRefs: schema.callIntents.externalRefs,
              recipientRegion: schema.callIntents.recipientRegion,
              attemptsCount: schema.callIntents.attemptsCount,
            })
            .from(schema.callIntents)
            .where(eq(schema.callIntents.id, attempt.intentId))
            .limit(1)
        )[0] ?? null);

  // --- recording + transcript into OUR store (E-34); vendor URLs are never persisted ------
  let recordingUri: string | null = null;
  let transcriptUri: string | null = null;
  let recordingError: string | null = null;
  if (ev.recordingUrl !== null) {
    try {
      recordingUri = await ctx.recordings.persistRecording(tenantId, attempt.id, ev.recordingUrl);
    } catch (error) {
      recordingError = error instanceof Error ? error.message : String(error);
      ctx.log.error({ err: error, attempt_id: attempt.id }, 'recording persist failed (E-34)');
    }
  }
  if (ev.transcript !== null)
    transcriptUri = await ctx.recordings.persistTranscript(tenantId, attempt.id, ev.transcript);

  // --- disclosures (invariant 7) ----------------------------------------------------------------
  let aiDisclosedAt = attempt.aiDisclosedAt;
  let recordingDisclosedAt = attempt.recordingDisclosedAt;
  const caps = ctx.registry.get(attempt.engine).capabilities();
  if (
    answeredBy === 'human' &&
    (aiDisclosedAt === null || recordingDisclosedAt === null) &&
    !caps.reportsDisclosure
  ) {
    // Engine cannot report it; the first utterance IS the disclosure, so answer time is the disclosure time.
    aiDisclosedAt = aiDisclosedAt ?? attempt.answeredAt ?? ev.at;
    recordingDisclosedAt = recordingDisclosedAt ?? attempt.answeredAt ?? ev.at;
  }
  const disclosureMissing =
    answeredBy === 'human' && (aiDisclosedAt === null || recordingDisclosedAt === null);

  // --- attempt terminal state -------------------------------------------------------------------
  const attemptStatus = disclosureMissing ? 'FAILED' : ATTEMPT_STATUS_BY_REASON[ev.reason];
  const costInr =
    ev.vendorCost !== null && ev.vendorCost.currency === 'INR' ? ev.vendorCost.minor : null;
  await tx
    .update(schema.callAttempts)
    .set({
      status: attemptStatus,
      endReason: disclosureMissing ? 'disclosure_not_logged' : ev.reason,
      endedAt: ev.at,
      lastEventAt: now,
      answeredBy,
      durationSec: ev.durationSec,
      billableSec: ev.billableSec,
      humanSpeechSec: ev.humanSpeechSec,
      recordingUri,
      transcriptUri,
      recordingPersistedAt: recordingUri === null ? null : now,
      aiDisclosedAt,
      recordingDisclosedAt,
      detectedLocale: ev.detectedLocale,
      costPaiseEngine: costInr,
      vendorCostMinor: ev.vendorCost?.minor ?? null,
      vendorCostCurrency: ev.vendorCost?.currency ?? null,
      error:
        recordingError === null && !disclosureMissing
          ? null
          : { recording: recordingError, disclosure_missing: disclosureMissing },
    })
    .where(eq(schema.callAttempts.id, attempt.id));

  if (disclosureMissing) {
    await audit(tx, {
      tenantId,
      actorType: 'worker',
      action: 'compliance.disclosure_missing',
      targetType: 'call_attempt',
      targetId: attempt.id,
      after: { engine: attempt.engine },
    });
    ctx.log.error(
      { attempt_id: attempt.id, engine: attempt.engine },
      'human answered but no disclosure logged — compliance incident (invariant 7)',
    );
  }

  if (attempt.direction === 'inbound') {
    return finalizeInbound(ctx, tx, tenantId, attempt, ev, {
      answeredBy,
      disclosureMissing,
      costInr,
      now,
    });
  }
  const { contactId, phoneHash } = attempt;
  if (contactId === null || phoneHash === null)
    throw new Error(`outbound attempt ${attempt.id} has no contact`);

  // --- outcome ----------------------------------------------------------------------------------------
  let outcome: (typeof schema.outcome.enumValues)[number] = OUTCOME_BY_REASON[ev.reason];
  let confidence = 0;
  let extracted: Record<string, unknown> = {};
  let extractionMethod: 'engine' | 'llm' | 'manual' = 'engine';
  if (ev.extracted !== null && attempt.scriptId !== null) {
    const [script] = await tx
      .select({ body: schema.scripts.body })
      .from(schema.scripts)
      .where(eq(schema.scripts.id, attempt.scriptId))
      .limit(1);
    const schemaName =
      (script?.body as { extraction?: string } | undefined)?.extraction ?? 'cod_confirm_v1';
    const parsed = parseExtraction(schemaName, ev.extracted);
    if (
      parsed.ok &&
      (schema.outcome.enumValues as readonly string[]).includes(parsed.value.outcome)
    ) {
      outcome = parsed.value.outcome as typeof outcome;
      confidence = parsed.value.confidence;
      extracted = parsed.value;
    } else {
      outcome = 'inconclusive';
      extractionMethod = 'engine';
      await audit(tx, {
        tenantId,
        actorType: 'worker',
        action: 'outcome.extraction_invalid',
        targetType: 'call_attempt',
        targetId: attempt.id,
        after: { error: parsed.ok ? 'outcome_not_in_enum' : parsed.error },
      });
    }
  }
  // The engine's end reason can override a stale extraction: an opt-out is an opt-out.
  if (
    ev.reason === 'opt_out' ||
    ev.reason === 'minor_answered' ||
    ev.reason === 'wrong_number' ||
    ev.reason === 'recording_refused'
  )
    outcome = OUTCOME_BY_REASON[ev.reason];

  // E-40: cancelled before/while ringing → superseded, never billed.
  const superseded = intent?.cancelledAt !== null && intent?.cancelledAt !== undefined;
  if (superseded) outcome = 'outcome_superseded';
  if (disclosureMissing) outcome = 'inconclusive';

  const verdict = isBillable({
    outcome,
    answeredBy,
    humanSpeechSec: ev.humanSpeechSec,
    superseded,
  });
  const outcomeId = newId('outcome');
  await tx.insert(schema.callOutcomes).values({
    id: outcomeId,
    tenantId,
    attemptId: attempt.id,
    intentId: attempt.intentId,
    outcome,
    confidence: confidence.toFixed(2),
    extracted,
    extractionMethod,
    billable: verdict.billable,
    billableReason: verdict.reason,
    superseded,
    writebackStatus: 'pending',
  });
  await audit(tx, {
    tenantId,
    actorType: 'worker',
    action: 'outcome.final',
    targetType: 'call_outcome',
    targetId: outcomeId,
    after: {
      attempt_id: attempt.id,
      outcome,
      confidence,
      billable: verdict.billable,
      billable_reason: verdict.reason,
      superseded,
    },
  });

  // --- side effects ---------------------------------------------------------------------------------------
  await releaseConcurrency(ctx.redis, tenantId, attempt.engine);
  if (costInr !== null) await recordSpend(ctx.redis, attempt.engine, costInr, now);

  const sup = suppressionFor(outcome);
  if (sup !== null) {
    const s = await suppress(tx, {
      scope: 'tenant',
      tenantId,
      phoneHash,
      purpose: sup.purpose,
      reason: sup.reason,
      at: now,
      sourceAttemptId: attempt.id,
      createdBy: `attempt:${attempt.id}`,
      ...(sup.scopedToOrder && attempt.externalRef !== null
        ? { externalRef: attempt.externalRef }
        : {}),
    });
    if (s.created) {
      await audit(tx, {
        tenantId,
        actorType: 'worker',
        action: 'suppression.created',
        targetType: 'suppression',
        targetId: s.id,
        after: { reason: sup.reason, until: s.until?.toISOString() ?? null },
      });
      await emitMerchantEvent(tx, tenantId, {
        type: 'suppression.created',
        eventId: `${s.id}:created`,
        at: now,
        data: {
          suppression_id: s.id,
          reason: sup.reason,
          until: s.until?.toISOString() ?? null,
          external_ref: attempt.externalRef,
        },
      });
    }
  }

  if (verdict.billable) {
    // How much: the plan's included allowance first, then the per-outcome price (ADR-0008).
    const meter = await meterOutcome(tx, {
      tenantId,
      outcomeId,
      at: now,
      vendorCostMinor: ev.vendorCost?.minor ?? null,
      vendorCostCurrency: ev.vendorCost?.currency ?? null,
    });
    await tx
      .update(schema.callOutcomes)
      .set({ billedAt: now, billingLedgerId: meter.ledgerId })
      .where(eq(schema.callOutcomes.id, outcomeId));
  }

  // --- intent: retry, exhaust or complete ---------------------------------------------------------------
  let intentStatus: string | null = null;
  let nextAttemptAt: Date | null = null;
  if (intent !== null) {
    const retryable =
      !verdict.billable &&
      !superseded &&
      isRetryEligible(outcome === 'inconclusive' ? ev.reason : outcome);
    if (superseded) {
      intentStatus = 'CANCELLED';
    } else if (retryable) {
      const [contact] = await tx
        .select({ timezone: schema.contacts.timezone })
        .from(schema.contacts)
        .where(eq(schema.contacts.id, contactId))
        .limit(1);
      const window = windowFor(intent.recipientRegion, contact?.timezone ?? null);
      nextAttemptAt =
        window === null
          ? null
          : nextRetryAt({ now, purpose: intent.purpose, notAfter: intent.notAfter, window });
      intentStatus = nextAttemptAt === null ? 'EXHAUSTED' : 'RETRY_SCHEDULED';
    } else {
      intentStatus = 'COMPLETED';
    }
    await tx
      .update(schema.callIntents)
      .set({
        status: intentStatus as (typeof schema.intentStatus.enumValues)[number],
        nextAttemptAt,
        ...(intentStatus === 'RETRY_SCHEDULED' ? {} : { completedAt: now }),
      })
      .where(
        and(eq(schema.callIntents.id, intent.id), eq(schema.callIntents.status, 'IN_PROGRESS')),
      );
    await audit(tx, {
      tenantId,
      actorType: 'worker',
      action: `intent.${intentStatus.toLowerCase()}`,
      targetType: 'call_intent',
      targetId: intent.id,
      after: { attempt_id: attempt.id, next_attempt_at: nextAttemptAt?.toISOString() ?? null },
    });
  }

  // --- merchant-facing events ------------------------------------------------------------------------------------
  await emitMerchantEvent(tx, tenantId, {
    type: 'call.completed',
    eventId: `${attempt.id}:completed`,
    at: now,
    data: {
      attempt_id: attempt.id,
      intent_id: attempt.intentId,
      attempt_no: attempt.attemptNo,
      answered_by: answeredBy,
      end_reason: ev.reason,
      duration_sec: ev.durationSec,
      external_refs: intent?.externalRefs ?? [],
    },
  });
  await emitMerchantEvent(tx, tenantId, {
    type: 'outcome.final',
    eventId: `${outcomeId}:final`,
    at: now,
    data: {
      outcome_id: outcomeId,
      attempt_id: attempt.id,
      intent_id: attempt.intentId,
      outcome,
      confidence,
      billable: verdict.billable,
      superseded,
      external_refs: intent?.externalRefs ?? [],
      extracted: scrubExtracted(extracted),
    },
  });

  // --- Shopify write-back: decided here, executed by the writebacks worker AFTER this commits ---
  // (P1-SHOP-2). A store call never runs inside this transaction: a slow or throttled Shopify
  // would otherwise hold row locks on the results path. The plan is rebuilt at execution time
  // from this row, so a merchant switching auto-cancel off in the meantime is respected.
  const [integration] =
    intent === null || superseded
      ? []
      : await tx
          .select({ id: schema.integrations.id })
          .from(schema.integrations)
          .where(
            and(
              eq(schema.integrations.tenantId, tenantId),
              eq(schema.integrations.kind, 'shopify'),
              eq(schema.integrations.status, 'active'),
            ),
          )
          .limit(1);
  await tx
    .update(schema.callOutcomes)
    .set(
      integration === undefined
        ? { writebackStatus: 'skipped' }
        : { writebackStatus: 'pending', writebackNextAt: now },
    )
    .where(eq(schema.callOutcomes.id, outcomeId));

  return { attemptStatus, outcome, billable: verdict.billable, intentStatus, nextAttemptAt };
}

/** Extraction fields safe to send to the merchant: no free-text address, no notes with names. */
export function scrubExtracted(extracted: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extracted)) {
    if (k === 'address_change' || k === 'notes' || k === 'summary')
      out[k] = v === undefined || v === null ? null : '[in dashboard]';
    else out[k] = v;
  }
  return out;
}
