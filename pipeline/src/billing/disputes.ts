import { and, eq } from 'drizzle-orm';
import { schema, type DbOrTx, type Tx } from '@naaradh/db';
import { NaaradhError, addDays, newId } from '@naaradh/shared';
import { audit, type ActorType } from '../audit.js';

/**
 * Outcome disputes (E-62, P2-BILL-2). A merchant disputes a BILLED outcome within 7 days; staff
 * review the evidence (recording, transcript, extraction, timestamps) and accept or reject. An
 * accepted dispute is a `credit` ledger row — the ledger is append-only, a billed outcome is
 * frozen (call_outcomes_billable_guard), so the correction is a new row, never an edit.
 *
 * Refund mechanics differ by provider: Razorpay credits net out of the next monthly add-on
 * (billing/postings.ts); Shopify has no app-credit mutation, so staff refund in the Partner
 * Dashboard and record it on the dispute (runbook billing-dispute.md).
 */

export const DISPUTE_WINDOW_DAYS = 7;

export async function openDispute(
  tx: DbOrTx,
  input: {
    readonly tenantId: string;
    readonly outcomeId: string;
    readonly reason: string;
    readonly openedBy: string;
    readonly actorType: ActorType;
    readonly at: Date;
  },
): Promise<string> {
  const [outcome] = await tx
    .select({
      id: schema.callOutcomes.id,
      billable: schema.callOutcomes.billable,
      billedAt: schema.callOutcomes.billedAt,
      ledgerId: schema.callOutcomes.billingLedgerId,
      createdAt: schema.callOutcomes.createdAt,
    })
    .from(schema.callOutcomes)
    .where(
      and(
        eq(schema.callOutcomes.tenantId, input.tenantId),
        eq(schema.callOutcomes.id, input.outcomeId),
      ),
    )
    .limit(1);
  if (outcome === undefined) throw new NaaradhError('NOT_FOUND', 'outcome not found');
  if (!outcome.billable || outcome.billedAt === null || outcome.ledgerId === null)
    throw new NaaradhError('VALIDATION_FAILED', 'only a billed outcome can be disputed');
  const [ledger] = await tx
    .select({ total: schema.billingLedger.totalMinor })
    .from(schema.billingLedger)
    .where(eq(schema.billingLedger.id, outcome.ledgerId))
    .limit(1);
  if (ledger === undefined || Number(ledger.total) <= 0)
    throw new NaaradhError(
      'VALIDATION_FAILED',
      'this outcome was within the plan allowance — nothing was charged',
    );
  if (input.at.getTime() > addDays(outcome.billedAt, DISPUTE_WINDOW_DAYS).getTime())
    throw new NaaradhError(
      'VALIDATION_FAILED',
      `disputes must be opened within ${String(DISPUTE_WINDOW_DAYS)} days of billing`,
    );
  const reason = input.reason.trim();
  if (reason.length < 10)
    throw new NaaradhError(
      'VALIDATION_FAILED',
      'say what was wrong with the call (at least 10 characters)',
    );

  const id = newId('dispute');
  const inserted = await tx
    .insert(schema.outcomeDisputes)
    .values({
      id,
      tenantId: input.tenantId,
      outcomeId: input.outcomeId,
      openedByUserId: input.openedBy,
      reason: reason.slice(0, 2000),
      status: 'open',
      openedAt: input.at,
    })
    .onConflictDoNothing()
    .returning({ id: schema.outcomeDisputes.id });
  if (inserted.length === 0)
    throw new NaaradhError('VALIDATION_FAILED', 'this outcome already has a dispute');
  await audit(tx, {
    tenantId: input.tenantId,
    actorType: input.actorType,
    actorId: input.openedBy,
    action: 'dispute.opened',
    targetType: 'outcome_dispute',
    targetId: id,
    after: { outcome_id: input.outcomeId },
  });
  return id;
}

/** Staff decision (service role). Accepting writes the credit; the refund route is recorded. */
export async function resolveDispute(
  tx: Tx,
  input: {
    readonly disputeId: string;
    readonly decision: 'accepted' | 'rejected';
    readonly by: string;
    readonly resolution: string;
    readonly at: Date;
  },
): Promise<{ readonly creditLedgerId: string | null }> {
  const [d] = await tx
    .select({
      id: schema.outcomeDisputes.id,
      tenantId: schema.outcomeDisputes.tenantId,
      status: schema.outcomeDisputes.status,
      ledgerId: schema.callOutcomes.billingLedgerId,
    })
    .from(schema.outcomeDisputes)
    .innerJoin(schema.callOutcomes, eq(schema.callOutcomes.id, schema.outcomeDisputes.outcomeId))
    .where(eq(schema.outcomeDisputes.id, input.disputeId))
    .for('update')
    .limit(1);
  if (d === undefined) throw new NaaradhError('NOT_FOUND', 'dispute not found');
  if (d.status !== 'open')
    throw new NaaradhError('VALIDATION_FAILED', `dispute is already ${d.status}`);
  if (input.resolution.trim().length < 10)
    throw new NaaradhError('VALIDATION_FAILED', 'a written resolution is required');

  let creditLedgerId: string | null = null;
  if (input.decision === 'accepted' && d.ledgerId !== null) {
    const [charge] = await tx
      .select()
      .from(schema.billingLedger)
      .where(eq(schema.billingLedger.id, d.ledgerId))
      .limit(1);
    if (charge !== undefined && Number(charge.totalMinor) > 0) {
      creditLedgerId = newId('ledger');
      await tx.insert(schema.billingLedger).values({
        id: creditLedgerId,
        tenantId: d.tenantId,
        kind: 'credit',
        ref: d.id,
        qty: 1,
        unitMinor: -Number(charge.totalMinor),
        totalMinor: -Number(charge.totalMinor),
        currency: charge.currency,
        period: input.at.toISOString().slice(0, 7),
        provider: charge.provider,
        notes: `credit for disputed ${charge.ref ?? 'outcome'}${charge.provider === 'shopify' ? ' — refund in Partner Dashboard' : ''}`,
      });
    }
  }
  await tx
    .update(schema.outcomeDisputes)
    .set({
      status: input.decision,
      resolvedBy: input.by,
      resolution: input.resolution.trim().slice(0, 2000),
      resolvedAt: input.at,
      creditLedgerId,
    })
    .where(eq(schema.outcomeDisputes.id, d.id));
  await audit(tx, {
    tenantId: d.tenantId,
    actorType: 'user',
    actorId: input.by,
    action: `dispute.${input.decision}`,
    targetType: 'outcome_dispute',
    targetId: d.id,
    after: { credit_ledger_id: creditLedgerId },
  });
  return { creditLedgerId };
}
