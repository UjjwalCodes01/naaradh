import { and, eq, sql } from 'drizzle-orm';
import { schema, withTenant } from '@naaradh/db';
import { audit } from '@naaradh/pipeline';
import { addMinutes } from '@naaradh/shared';
import type { WorkerContext } from '../context.js';
import { isRetryableWritebackError } from '../results/shopify-writeback.js';
import { planWriteback, type WritebackPlan } from '../results/writeback.js';

/**
 * writebacks worker (P1-SHOP-2, AGENTS §5.4). Executes the Shopify write-back that
 * `finalizeAttempt()` scheduled on the outcome row — tags, note, metafields and (only with
 * auto-cancel on AND confidence ≥ 0.9, invariant 14) the cancel — OUTSIDE any transaction.
 *
 *   claim     SKIP LOCKED on due rows; the claim pushes writeback_next_at forward as a lease,
 *             so a crashed worker's row is picked up again after LEASE_MIN
 *   plan      rebuilt from the row + CURRENT tenant settings (auto-cancel switched off since
 *             the call → no cancel)
 *   retry     retryable failures back off 2, 4, 8 … 60 min, at most MAX_ATTEMPTS; a failure
 *             that cannot succeed (revoked token, store disconnected, Shopify refusal) stops
 *             at once and is left `failed` for the dashboard (runbook: shopify-writeback.md)
 */

const MAX_ATTEMPTS = 6;
const LEASE_MIN = 5;

export interface WritebacksReport {
  readonly claimed: number;
  readonly done: number;
  readonly retrying: number;
  readonly failed: number;
  readonly skipped: number;
}

export async function runWritebacksOnce(ctx: WorkerContext, batch = 10): Promise<WritebacksReport> {
  const now = ctx.clock.now();
  const claimed = await ctx.service.execute<{
    id: string;
    tenant_id: string;
    writeback_attempts: number;
  }>(sql`
    update call_outcomes
    set writeback_attempts = writeback_attempts + 1,
        writeback_next_at = ${addMinutes(now, LEASE_MIN)}::timestamptz
    where id in (
      select id from call_outcomes
      where writeback_status in ('pending', 'failed')
        and writeback_next_at is not null
        and writeback_next_at <= ${now}::timestamptz
      order by writeback_next_at
      limit ${batch}
      for update skip locked
    )
    returning id, tenant_id, writeback_attempts
  `);
  const report = { claimed: claimed.rows.length, done: 0, retrying: 0, failed: 0, skipped: 0 };
  for (const row of claimed.rows) {
    const result = await executeWriteback(ctx, row.id, row.tenant_id, row.writeback_attempts).catch(
      (error: unknown) => {
        ctx.log.error(
          { err: error, outcome_id: row.id, tenant_id: row.tenant_id },
          'writeback crashed',
        );
        return 'retrying' as const;
      },
    );
    report[result] += 1;
  }
  return report;
}

type Result = 'done' | 'retrying' | 'failed' | 'skipped';

interface Job {
  readonly store: { readonly shopDomain: string; readonly credentialsSecretRef: string | null };
  readonly orderIds: readonly string[];
  readonly plan: WritebackPlan;
}

async function executeWriteback(
  ctx: WorkerContext,
  outcomeId: string,
  tenantId: string,
  attempts: number,
): Promise<Result> {
  const now = ctx.clock.now();

  // Phase A: rebuild the plan inside the tenant.
  const job = await withTenant(ctx.app, tenantId, async (tx): Promise<Job | null> => {
    const [row] = await tx
      .select({
        outcome: schema.callOutcomes.outcome,
        confidence: schema.callOutcomes.confidence,
        extracted: schema.callOutcomes.extracted,
        superseded: schema.callOutcomes.superseded,
        endedAt: schema.callAttempts.endedAt,
        externalRefs: schema.callIntents.externalRefs,
        attemptsCount: schema.callIntents.attemptsCount,
        autoCancelEnabled: schema.tenants.autoCancelEnabled,
        addressWriteEnabled: schema.tenants.addressWriteEnabled,
      })
      .from(schema.callOutcomes)
      .innerJoin(schema.callAttempts, eq(schema.callAttempts.id, schema.callOutcomes.attemptId))
      .innerJoin(schema.callIntents, eq(schema.callIntents.id, schema.callOutcomes.intentId))
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.callOutcomes.tenantId))
      .where(eq(schema.callOutcomes.id, outcomeId))
      .limit(1);
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
    // Superseded since, or the store was disconnected/uninstalled: nothing to write to.
    if (row === undefined || row.superseded || integration === undefined) {
      await tx
        .update(schema.callOutcomes)
        .set({
          writebackStatus: 'skipped',
          writebackNextAt: null,
          writebackError: row?.superseded === true ? 'superseded' : 'no_active_store',
        })
        .where(eq(schema.callOutcomes.id, outcomeId));
      return null;
    }
    const extracted = row.extracted as Record<string, unknown>;
    return {
      store: {
        shopDomain: integration.externalId,
        credentialsSecretRef: integration.credentialsSecretRef,
      },
      orderIds: row.externalRefs,
      plan: planWriteback({
        outcome: row.outcome,
        confidence: Number(row.confidence),
        attempts: row.attemptsCount,
        outcomeId,
        lastCallAt: row.endedAt ?? now,
        summary: typeof extracted['notes'] === 'string' ? extracted['notes'] : row.outcome,
        addressChange:
          typeof extracted['address_change'] === 'string' ? extracted['address_change'] : null,
        tenant: {
          autoCancelEnabled: row.autoCancelEnabled,
          addressWriteEnabled: row.addressWriteEnabled,
        },
      }),
    };
  });
  if (job === null) return 'skipped';

  // Phase B: the store call, outside any transaction.
  let failure: unknown = null;
  try {
    await ctx.shopify.apply(tenantId, job.store, job.orderIds, job.plan);
  } catch (error) {
    failure = error;
  }

  // Phase C: record what happened.
  return withTenant(ctx.app, tenantId, async (tx) => {
    if (failure === null) {
      await tx
        .update(schema.callOutcomes)
        .set({
          writebackStatus: job.plan.needsReview ? 'needs_review' : 'done',
          writebackAt: now,
          writebackNextAt: null,
          writebackError: null,
        })
        .where(eq(schema.callOutcomes.id, outcomeId));
      await audit(tx, {
        tenantId,
        actorType: 'worker',
        actorId: ctx.workerId,
        action: 'outcome.writeback_done',
        targetType: 'call_outcome',
        targetId: outcomeId,
        after: {
          tags: job.plan.tags,
          cancel: job.plan.cancelOrder,
          needs_review: job.plan.needsReview,
          orders: job.orderIds.length,
        },
      });
      return 'done';
    }
    const message = (
      failure instanceof Error ? `${failure.name}: ${failure.message}` : 'non-Error thrown'
    ).slice(0, 500);
    const retry = isRetryableWritebackError(failure) && attempts < MAX_ATTEMPTS;
    await tx
      .update(schema.callOutcomes)
      .set({
        writebackStatus: 'failed',
        writebackError: message,
        writebackNextAt: retry ? addMinutes(now, Math.min(60, 2 ** attempts)) : null,
      })
      .where(eq(schema.callOutcomes.id, outcomeId));
    if (!retry) {
      await audit(tx, {
        tenantId,
        actorType: 'worker',
        actorId: ctx.workerId,
        action: 'outcome.writeback_failed',
        targetType: 'call_outcome',
        targetId: outcomeId,
        after: { error: message, attempts },
      });
      ctx.log.error(
        { outcome_id: outcomeId, tenant_id: tenantId, attempts, error: message },
        'shopify writeback gave up',
      );
      return 'failed';
    }
    ctx.log.warn(
      { outcome_id: outcomeId, tenant_id: tenantId, attempts, error: message },
      'shopify writeback failed; will retry',
    );
    return 'retrying';
  });
}

export async function runWritebacks(
  ctx: WorkerContext,
  pollMs: number,
  signal: AbortSignal,
): Promise<void> {
  ctx.log.info({ poll_ms: pollMs }, 'writebacks worker started');
  while (!signal.aborted) {
    try {
      const report = await runWritebacksOnce(ctx);
      if (report.claimed > 0) ctx.log.info(report, 'writebacks pass');
    } catch (error) {
      ctx.log.error({ err: error }, 'writebacks pass failed');
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
