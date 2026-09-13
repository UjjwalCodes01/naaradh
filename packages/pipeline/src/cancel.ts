import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import { audit, type ActorType } from './audit.js';
import { emitMerchantEvent } from './outbox.js';

/**
 * Cancellation (AGENTS §5.6, E-40). Sources: orders/cancelled, orders/updated with a
 * terminal status, merchant cancel via API/dashboard, uninstall, kill switch, campaign stop.
 *
 *   SCHEDULED / RETRY_SCHEDULED  → CANCELLED now (the queue row is the task; ADR-0005)
 *   DISPATCHING / IN_PROGRESS    → cancelled_at stamped; the dispatcher/results-consumer see
 *                                  it and either cancel the live call (if the engine can) or
 *                                  mark the outcome superseded and non-billable.
 */
export interface CancelResult {
  readonly cancelled: string[];
  readonly flaggedLive: string[];
}

export async function cancelIntents(
  tx: DbOrTx,
  input: {
    tenantId: string;
    externalRef?: string;
    intentId?: string;
    /** Only intents of this use case (E-97 cancels the COD confirmation, nothing else). */
    useCase?: (typeof schema.useCaseKind.enumValues)[number];
    /** Leave live calls alone — only queued intents are cancelled (E-97: the caller is on another call). */
    queuedOnly?: boolean;
    reason: string;
    at: Date;
    actor: { type: ActorType; id?: string };
  },
): Promise<CancelResult> {
  const target =
    input.intentId !== undefined
      ? eq(schema.callIntents.id, input.intentId)
      : sql`${input.externalRef ?? ''} = any(${schema.callIntents.externalRefs})`;
  const scope =
    input.useCase === undefined
      ? target
      : and(target, eq(schema.callIntents.useCase, input.useCase));

  const cancelled = await tx
    .update(schema.callIntents)
    .set({
      status: 'CANCELLED',
      cancelledAt: input.at,
      cancelReason: input.reason,
      nextAttemptAt: null,
      claimedAt: null,
      claimedBy: null,
    })
    .where(
      and(
        eq(schema.callIntents.tenantId, input.tenantId),
        scope,
        inArray(schema.callIntents.status, ['CREATED', 'SCHEDULED', 'RETRY_SCHEDULED', 'GATED']),
      ),
    )
    .returning({ id: schema.callIntents.id });

  const live =
    input.queuedOnly === true
      ? []
      : await tx
          .update(schema.callIntents)
          .set({ cancelledAt: input.at, cancelReason: input.reason })
          .where(
            and(
              eq(schema.callIntents.tenantId, input.tenantId),
              scope,
              inArray(schema.callIntents.status, ['DISPATCHING', 'IN_PROGRESS']),
              sql`${schema.callIntents.cancelledAt} is null`,
            ),
          )
          .returning({ id: schema.callIntents.id });

  for (const row of [...cancelled, ...live]) {
    await audit(tx, {
      tenantId: input.tenantId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: cancelled.includes(row) ? 'intent.cancelled' : 'intent.cancel_requested',
      targetType: 'call_intent',
      targetId: row.id,
      after: { reason: input.reason },
    });
  }
  for (const row of cancelled) {
    await emitMerchantEvent(tx, input.tenantId, {
      type: 'intent.cancelled',
      eventId: `${row.id}:cancelled`,
      at: input.at,
      data: { intent_id: row.id, reason: input.reason },
    });
  }
  return { cancelled: cancelled.map((r) => r.id), flaggedLive: live.map((r) => r.id) };
}
