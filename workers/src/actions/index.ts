import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, withTenant, type Tx } from '@naaradh/db';
import { isShipped } from '@naaradh/compliance';
import { audit, createTicket, emitMerchantEvent, markOrderCancelled } from '@naaradh/pipeline';
import { addMinutes } from '@naaradh/shared';
import type { WorkerContext } from '../context.js';
import { runLoop } from '../loop.js';
import { isRetryableWritebackError } from '../results/shopify-writeback.js';

/**
 * actions worker (ADR-0006). Executes what the voice agent was ALLOWED to do — today one
 * thing: a two-step, caller-confirmed cancellation of an unshipped COD order on a tenant that
 * switched agent cancellation on (invariant 14 as amended). The approval is the immutable
 * agent_actions row; this queue row is only the work.
 *
 * Every guard is re-checked at execution time, because minutes pass between the caller's
 * "yes" and the store call: shipped since → ticket; setting switched off since → ticket.
 * Failures back off; after MAX_ATTEMPTS the action is dead and a human gets a ticket
 * (runbook: docs/runbooks/agent-action-failed.md).
 */

const MAX_ATTEMPTS = 5;
const STALE_EXECUTING_MIN = 5;

export interface ActionsReport {
  readonly claimed: number;
  readonly done: number;
  readonly failed: number;
  readonly dead: number;
}

export async function runActionsOnce(ctx: WorkerContext, batch = 10): Promise<ActionsReport> {
  const now = ctx.clock.now();
  // A worker that died mid-execution leaves 'executing' behind: hand it back to the queue.
  await ctx.service.execute(sql`
    update order_actions set status = 'failed', next_attempt_at = ${now}::timestamptz, last_error = 'stale_executing'
    where status = 'executing' and updated_at < ${addMinutes(now, -STALE_EXECUTING_MIN)}::timestamptz
  `);
  const claimed = await ctx.service.execute<{
    id: string;
    tenant_id: string;
    attempts: number;
  }>(sql`
    update order_actions set status = 'executing', attempts = attempts + 1
    where id in (
      select id from order_actions
      where status in ('pending', 'failed') and coalesce(next_attempt_at, created_at) <= ${now}::timestamptz
      order by next_attempt_at nulls first
      limit ${batch}
      for update skip locked
    )
    returning id, tenant_id, attempts
  `);
  const report = { claimed: claimed.rows.length, done: 0, failed: 0, dead: 0 };
  for (const row of claimed.rows) {
    const result = await executeOrderAction(ctx, row.id, row.tenant_id, row.attempts).catch(
      (error: unknown) => {
        ctx.log.error(
          { err: error, order_action_id: row.id, tenant_id: row.tenant_id },
          'order action crashed',
        );
        return 'failed' as const;
      },
    );
    report[result] += 1;
  }
  return report;
}

type Result = 'done' | 'failed' | 'dead';

async function executeOrderAction(
  ctx: WorkerContext,
  id: string,
  tenantId: string,
  attempts: number,
): Promise<Result> {
  const now = ctx.clock.now();
  // Phase A: re-check every guard and decide, inside the tenant.
  const plan = await withTenant(ctx.app, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: schema.orderActions.id,
        kind: schema.orderActions.kind,
        agentActionId: schema.orderActions.agentActionId,
        order: schema.orders,
        attemptId: schema.agentActions.attemptId,
      })
      .from(schema.orderActions)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderActions.orderId))
      .innerJoin(schema.agentActions, eq(schema.agentActions.id, schema.orderActions.agentActionId))
      .where(eq(schema.orderActions.id, id))
      .limit(1);
    if (row === undefined) return { kind: 'gone' as const };
    const order = row.order;

    if (order.cancelledAt !== null) {
      await finish(tx, id, 'done', null, now);
      return { kind: 'settled' as const, result: 'done' as const };
    }
    const enabled = await agentCancelEnabled(tx, tenantId, row.attemptId);
    const blocker =
      order.erasedAt !== null
        ? 'order_erased'
        : isShipped(order)
          ? 'shipped_before_execution'
          : !enabled
            ? 'agent_cancel_disabled_since'
            : null;
    if (blocker !== null) {
      await handOver(tx, tenantId, id, row.attemptId, order, blocker, now);
      return { kind: 'settled' as const, result: 'dead' as const };
    }
    if (order.source !== 'shopify') {
      // API / WooCommerce merchants execute it themselves from order.cancellation_requested.
      await finish(tx, id, 'done', null, now);
      await audit(tx, {
        tenantId,
        actorType: 'worker',
        action: 'order.cancel_delegated',
        targetType: 'order',
        targetId: order.id,
        after: { order_action_id: id, source: order.source },
      });
      return { kind: 'settled' as const, result: 'done' as const };
    }
    const [integration] = await tx
      .select({
        externalId: schema.integrations.externalId,
        credentialsSecretRef: schema.integrations.credentialsSecretRef,
      })
      .from(schema.integrations)
      .where(
        and(
          eq(schema.integrations.tenantId, tenantId),
          eq(schema.integrations.kind, 'shopify'),
          eq(schema.integrations.status, 'active'),
        ),
      )
      .limit(1);
    if (integration === undefined) {
      await handOver(tx, tenantId, id, row.attemptId, order, 'no_active_store_connection', now);
      return { kind: 'settled' as const, result: 'dead' as const };
    }
    return {
      kind: 'execute' as const,
      store: {
        shopDomain: integration.externalId,
        credentialsSecretRef: integration.credentialsSecretRef,
      },
      order,
    };
  });
  if (plan.kind === 'gone') return 'dead';
  if (plan.kind === 'settled') return plan.result;

  // Phase B: the store call, outside any transaction.
  try {
    await ctx.shopify.apply(tenantId, plan.store, [plan.order.externalId], {
      tags: ['naaradh:cancelled-by-caller'],
      note: `Naaradh · ${now.toISOString()} · cancelled at the customer's request on a phone call (confirmed twice) · action ${id}`,
      metafields: { agent_action: id },
      cancelOrder: true,
      needsReview: false,
    });
  } catch (error) {
    const message = (
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    ).slice(0, 500);
    // A revoked token, a disconnected store or a refusal from Shopify will not fix itself:
    // hand it to a person now rather than after half an hour of retries.
    const retryable = isRetryableWritebackError(error);
    return withTenant(ctx.app, tenantId, async (tx) => {
      if (!retryable || attempts >= MAX_ATTEMPTS) {
        const [row] = await tx
          .select({ attemptId: schema.agentActions.attemptId })
          .from(schema.orderActions)
          .innerJoin(
            schema.agentActions,
            eq(schema.agentActions.id, schema.orderActions.agentActionId),
          )
          .where(eq(schema.orderActions.id, id))
          .limit(1);
        await handOver(
          tx,
          tenantId,
          id,
          row?.attemptId ?? null,
          plan.order,
          `store_error: ${message}`,
          now,
        );
        return 'dead' as const;
      }
      await tx
        .update(schema.orderActions)
        .set({
          status: 'failed',
          lastError: message,
          nextAttemptAt: addMinutes(now, 2 ** attempts),
        })
        .where(eq(schema.orderActions.id, id));
      ctx.log.warn(
        { order_action_id: id, tenant_id: tenantId, attempts },
        'order cancel failed; will retry',
      );
      return 'failed' as const;
    });
  }

  // Phase C: record it.
  await withTenant(ctx.app, tenantId, async (tx) => {
    await finish(tx, id, 'done', null, now);
    await markOrderCancelled(tx, tenantId, 'shopify', plan.order.externalId, now);
    await audit(tx, {
      tenantId,
      actorType: 'worker',
      actorId: ctx.workerId,
      action: 'order.cancelled_by_agent',
      targetType: 'order',
      targetId: plan.order.id,
      after: { order_action_id: id },
    });
    await emitMerchantEvent(tx, tenantId, {
      type: 'order.cancelled_by_agent',
      eventId: `${id}:done`,
      at: now,
      data: {
        order_id: plan.order.id,
        external_id: plan.order.externalId,
        order_name: plan.order.name,
        order_action_id: id,
      },
    });
  });
  return 'done';
}

async function finish(
  tx: Tx,
  id: string,
  status: 'done' | 'dead',
  error: string | null,
  now: Date,
): Promise<void> {
  await tx
    .update(schema.orderActions)
    .set({ status, lastError: error, doneAt: now, nextAttemptAt: null })
    .where(eq(schema.orderActions.id, id));
}

/** The agent may not finish it: a person gets a ticket with the reason, the queue row dies. */
async function handOver(
  tx: Tx,
  tenantId: string,
  id: string,
  attemptId: string | null,
  order: typeof schema.orders.$inferSelect,
  reason: string,
  now: Date,
): Promise<void> {
  await finish(tx, id, 'dead', reason, now);
  if (order.erasedAt === null) {
    await createTicket(tx, {
      tenantId,
      attemptId,
      contactId: null,
      orderId: order.id,
      category: 'cancellation',
      summary: `A caller confirmed cancelling order ${order.name} on the phone, but it could not be cancelled automatically (${reason}). Please handle it.`,
      callbackRequested: false,
      preferredTime: null,
      source: 'agent',
      priority: 90,
      at: now,
      actor: { type: 'worker' },
    });
  }
  await audit(tx, {
    tenantId,
    actorType: 'worker',
    action: 'order.cancel_handed_over',
    targetType: 'order',
    targetId: order.id,
    after: { order_action_id: id, reason },
  });
}

/** The setting that applied at approval must still apply now — the merchant may have switched it off. */
async function agentCancelEnabled(tx: Tx, tenantId: string, attemptId: string): Promise<boolean> {
  const [attempt] = await tx
    .select({ profileId: schema.callAttempts.inboundProfileId })
    .from(schema.callAttempts)
    .where(eq(schema.callAttempts.id, attemptId))
    .limit(1);
  const profileId = attempt?.profileId ?? null;
  const [profile] =
    profileId !== null
      ? await tx
          .select({ on: schema.inboundProfiles.agentCancelEnabled })
          .from(schema.inboundProfiles)
          .where(eq(schema.inboundProfiles.id, profileId))
          .limit(1)
      : await tx
          .select({ on: schema.inboundProfiles.agentCancelEnabled })
          .from(schema.inboundProfiles)
          .where(
            and(
              eq(schema.inboundProfiles.tenantId, tenantId),
              eq(schema.inboundProfiles.status, 'active'),
            ),
          )
          .orderBy(desc(schema.inboundProfiles.updatedAt))
          .limit(1);
  return profile?.on === true;
}

export async function runActions(
  ctx: WorkerContext,
  pollMs: number,
  signal: AbortSignal,
): Promise<void> {
  await runLoop({
    name: 'actions',
    log: ctx.log,
    intervalMs: pollMs,
    signal,
    async tick() {
      const report = await runActionsOnce(ctx);
      if (report.claimed > 0) ctx.log.info(report, 'actions pass');
    },
  });
}
