import { and, eq } from 'drizzle-orm';
import { schema, withTenant, type Tx } from '@naaradh/db';
import type { EngineEvent } from '@naaradh/engines-core';
import { audit } from '@naaradh/pipeline';
import type { EventMessage } from '../bus.js';
import type { WorkerContext } from '../context.js';
import { loadWebhookEvent, markWebhookFailed, markWebhookProcessed } from '../webhook-events.js';
import { finalizeAttempt, type AttemptRow } from './finalize.js';

/**
 * results-consumer (AGENTS §5.4). Applies one normalised engine event to one attempt.
 *
 *   dedupe        already done by hooks on eventId (E-22); a redelivery finds status processed
 *   ordering      a terminal attempt ignores ringing/answered arriving late (E-22 out-of-order)
 *   unsigned      an event from an unsigned vendor is confirmed with fetchCall first (E-23)
 *   not-yet-known the attempt is resolved by our echoed attempt id, else engine call id; if
 *                 neither exists yet (dispatcher mid-commit), throw → nack → redelivered
 */
const TERMINAL = new Set([
  'ENDED',
  'NO_ANSWER',
  'BUSY',
  'AMD_HANGUP',
  'AMD_MESSAGE_LEFT',
  'FAILED',
  'CANCELLED',
]);

export async function handleEngineEvent(ctx: WorkerContext, message: EventMessage): Promise<void> {
  const event = await loadWebhookEvent(ctx.service, message.webhook_event_id);
  if (event === null || event.tenantId === null) return;
  if (event.status === 'processed') return;
  const tenantId = event.tenantId;
  const ev = reviveEvent(event.payload);
  if (ev === null) {
    await markWebhookProcessed(ctx.service, event.id, 'unparseable_event');
    return;
  }

  try {
    const note = await withTenant(ctx.app, tenantId, async (tx) => {
      const attempt = await findAttempt(tx, tenantId, ev);
      if (attempt === null)
        throw new Error(
          `attempt not found for ${ev.ref.vendor}/${ev.ref.callId} (attempt ${ev.attemptId ?? '-'})`,
        );

      // E-23: unsigned vendor → the payload is a hint; confirm against the vendor's API.
      if (!event.signatureValid && ev.type === 'call.ended') {
        const snap = await ctx.registry.get(attempt.engine).fetchCall(ev.ref);
        if (snap.status !== 'ended' || snap.endReason !== ev.reason) {
          await audit(tx, {
            tenantId,
            actorType: 'worker',
            action: 'results.unsigned_mismatch',
            targetType: 'call_attempt',
            targetId: attempt.id,
            after: { claimed: ev.reason, fetched: snap.endReason, status: snap.status },
          });
          return 'unsigned_mismatch_ignored';
        }
      }

      const terminal = TERMINAL.has(attempt.status);
      const now = ctx.clock.now();
      switch (ev.type) {
        case 'call.ringing':
          if (terminal || attempt.status === 'IN_CONVERSATION' || attempt.status === 'TRANSFERRING')
            return 'late_ringing_ignored';
          await tx
            .update(schema.callAttempts)
            .set({
              status: 'RINGING',
              startedAt: ev.at,
              lastEventAt: now,
              ...(attempt.engineCallId === null ? { engineCallId: ev.ref.callId } : {}),
            })
            .where(eq(schema.callAttempts.id, attempt.id));
          return 'ringing';
        case 'call.answered':
          if (terminal) return 'late_answered_ignored';
          await tx
            .update(schema.callAttempts)
            .set({
              status: 'IN_CONVERSATION',
              answeredAt: ev.at,
              answeredBy: ev.answeredBy,
              lastEventAt: now,
              ...(attempt.engineCallId === null ? { engineCallId: ev.ref.callId } : {}),
            })
            .where(eq(schema.callAttempts.id, attempt.id));
          return `answered:${ev.answeredBy}`;
        case 'call.disclosed':
          await tx
            .update(schema.callAttempts)
            .set({
              aiDisclosedAt: ev.aiDisclosedAt,
              recordingDisclosedAt: ev.recordingDisclosedAt,
              lastEventAt: now,
            })
            .where(eq(schema.callAttempts.id, attempt.id));
          return 'disclosed';
        case 'call.transferred': {
          if (terminal) return 'late_transfer_ignored';
          const result =
            ev.result === 'completed'
              ? 'completed'
              : ev.result === 'busy'
                ? 'busy'
                : ev.result === 'no_answer'
                  ? 'no_answer'
                  : 'failed';
          await tx
            .update(schema.callAttempts)
            .set({ status: 'TRANSFERRING', transferResult: result, lastEventAt: now })
            .where(eq(schema.callAttempts.id, attempt.id));
          await audit(tx, {
            tenantId,
            actorType: 'engine',
            action: 'attempt.transfer',
            targetType: 'call_attempt',
            targetId: attempt.id,
            after: { result, to_masked: ev.toMasked },
          });
          return `transferred:${result}`;
        }
        case 'call.ended': {
          if (attempt.engineCallId === null)
            await tx
              .update(schema.callAttempts)
              .set({ engineCallId: ev.ref.callId })
              .where(eq(schema.callAttempts.id, attempt.id));
          const r = await finalizeAttempt(ctx, tx, tenantId, attempt, ev, {
            signatureValid: event.signatureValid,
          });
          return r === null
            ? 'ended_duplicate'
            : `ended:${r.outcome}:${r.billable ? 'billable' : 'free'}:${r.intentStatus ?? '-'}`;
        }
        case 'call.failed': {
          if (terminal) return 'late_failed_ignored';
          const synthetic = {
            ...ev,
            type: 'call.ended' as const,
            reason: ev.retryable ? ('carrier_temp_fail' as const) : ('engine_error' as const),
            answeredBy: 'unknown' as const,
            durationSec: 0,
            billableSec: 0,
            humanSpeechSec: 0,
            recordingUrl: null,
            transcript: null,
            extracted: null,
            detectedLocale: null,
            vendorCost: null,
          };
          const r = await finalizeAttempt(ctx, tx, tenantId, attempt, synthetic, {
            signatureValid: event.signatureValid,
          });
          return r === null ? 'failed_duplicate' : `failed:${ev.code}:${r.intentStatus ?? '-'}`;
        }
      }
    });
    await markWebhookProcessed(ctx.service, event.id, note);
  } catch (error) {
    await markWebhookFailed(
      ctx.service,
      event.id,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

async function findAttempt(
  tx: Tx,
  tenantId: string,
  ev: EngineEvent,
): Promise<(AttemptRow & { engineCallId: string | null }) | null> {
  const cols = {
    id: schema.callAttempts.id,
    intentId: schema.callAttempts.intentId,
    direction: schema.callAttempts.direction,
    contactId: schema.callAttempts.contactId,
    phoneHash: schema.callAttempts.phoneHash,
    purpose: schema.callAttempts.purpose,
    externalRef: schema.callAttempts.externalRef,
    attemptNo: schema.callAttempts.attemptNo,
    engine: schema.callAttempts.engine,
    engineCallId: schema.callAttempts.engineCallId,
    status: schema.callAttempts.status,
    answeredBy: schema.callAttempts.answeredBy,
    answeredAt: schema.callAttempts.answeredAt,
    aiDisclosedAt: schema.callAttempts.aiDisclosedAt,
    recordingDisclosedAt: schema.callAttempts.recordingDisclosedAt,
    scriptId: schema.callAttempts.scriptId,
  };
  if (ev.attemptId !== null) {
    const [byId] = await tx
      .select(cols)
      .from(schema.callAttempts)
      .where(
        and(eq(schema.callAttempts.tenantId, tenantId), eq(schema.callAttempts.id, ev.attemptId)),
      )
      .limit(1);
    if (byId !== undefined) return byId;
  }
  const [byCall] = await tx
    .select(cols)
    .from(schema.callAttempts)
    .where(
      and(
        eq(schema.callAttempts.tenantId, tenantId),
        eq(schema.callAttempts.engine, ev.ref.vendor),
        eq(schema.callAttempts.engineCallId, ev.ref.callId),
      ),
    )
    .limit(1);
  return byCall ?? null;
}

/** JSONB round-trip turns Dates into ISO strings; restore the ones the code compares. */
function reviveEvent(payload: unknown): EngineEvent | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p['type'] !== 'string' || typeof p['eventId'] !== 'string') return null;
  const revived: Record<string, unknown> = {
    ...p,
    at: new Date(String(p['at'])),
    attemptId: typeof p['attemptId'] === 'string' ? p['attemptId'] : null,
  };
  if (p['type'] === 'call.disclosed') {
    revived['aiDisclosedAt'] = new Date(String(p['aiDisclosedAt']));
    revived['recordingDisclosedAt'] = new Date(String(p['recordingDisclosedAt']));
  }
  return revived as unknown as EngineEvent;
}
