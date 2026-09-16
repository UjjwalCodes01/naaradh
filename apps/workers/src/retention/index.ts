import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { schema, withTenant } from '@naaradh/db';
import {
  CHECKOUT_RETENTION_DAYS,
  ERASURE_COMPLETION_TARGET_DAYS,
  ORDER_CACHE_RETENTION_DAYS,
} from '@naaradh/compliance';
import {
  audit,
  emitMerchantEvent,
  eraseCheckouts,
  eraseOrdersPlacedBefore,
  eraseSubject,
  markMediaPurged,
  mediaDueForRetention,
  subjectMedia,
  type ErasureCounts,
} from '@naaradh/pipeline';
import { addDays, addMinutes } from '@naaradh/shared';
import type { WorkerContext } from '../context.js';
import { runLoop } from '../loop.js';

/**
 * retention worker (AGENTS §4, P2-CMP-3/4). Two jobs:
 *
 *   erasure    `erasure_requests` → every tenant holding the phone hash (or the one named) is
 *              scrubbed: media deleted from our store, contact tombstoned, extraction free text,
 *              intent variables, order cache and ticket text removed. Target: done within
 *              ERASURE_COMPLETION_TARGET_DAYS of the request (Q-06); overdue is an alert.
 *   retention  per tenant, media older than `retention_days` is deleted; order-cache rows older
 *              than ORDER_CACHE_RETENTION_DAYS are tombstoned.
 *
 * Media deletes happen OUTSIDE transactions; see packages/pipeline/src/privacy.ts.
 */

const STALE_IN_PROGRESS_MIN = 60;
const MEDIA_BATCH = 200;

export interface ErasureReport {
  readonly completed: number;
  readonly failed: number;
  readonly overdue: number;
}

export async function runErasuresOnce(ctx: WorkerContext, batch = 5): Promise<ErasureReport> {
  const now = ctx.clock.now();
  const claimed = await ctx.service.execute<{
    id: string;
    tenant_id: string | null;
    phone_hash: string;
    source: string;
  }>(sql`
    update erasure_requests set status = 'in_progress', started_at = ${now}::timestamptz, error = null
    where id in (
      select id from erasure_requests
      where status = 'requested'
         -- a crashed worker's claim, or a failure worth another go an hour later
         or (status in ('in_progress', 'failed') and updated_at < ${addMinutes(now, -STALE_IN_PROGRESS_MIN)}::timestamptz)
      order by due_at
      limit ${batch}
      for update skip locked
    )
    returning id, tenant_id, phone_hash, source
  `);
  const report = { completed: 0, failed: 0, overdue: 0 };
  for (const req of claimed.rows) {
    try {
      const tenants =
        req.tenant_id !== null
          ? [req.tenant_id]
          : (
              await ctx.service.execute<{ tenant_id: string }>(sql`
                select tenant_id from contacts where phone_hash = ${req.phone_hash}
                union select tenant_id from call_attempts where phone_hash = ${req.phone_hash}
                union select tenant_id from orders where phone_hash = ${req.phone_hash}
              `)
            ).rows.map((r) => r.tenant_id);
      const perTenant: Record<string, ErasureCounts> = {};
      for (const tenantId of tenants) {
        const media = await withTenant(ctx.app, tenantId, (tx) =>
          subjectMedia(tx, tenantId, req.phone_hash),
        );
        for (const uri of media.uris) await ctx.recordings.delete(uri);
        perTenant[tenantId] = await withTenant(ctx.app, tenantId, async (tx) => {
          const counts = await eraseSubject(tx, {
            tenantId,
            phoneHash: req.phone_hash,
            at: now,
            mediaObjectsDeleted: media.uris.length,
          });
          await audit(tx, {
            tenantId,
            actorType: 'worker',
            actorId: ctx.workerId,
            action: 'erasure.tenant_done',
            targetType: 'erasure_request',
            targetId: req.id,
            after: counts,
          });
          await emitMerchantEvent(tx, tenantId, {
            type: 'erasure.completed',
            eventId: `${req.id}:${tenantId}:completed`,
            at: now,
            data: { erasure_request_id: req.id, source: req.source },
          });
          return counts;
        });
      }
      await ctx.service
        .update(schema.erasureRequests)
        .set({
          status: 'completed',
          completedAt: now,
          // Webhook payloads (which may carry the number) are nulled after 30 days by reconcile.
          report: { tenants: perTenant, webhook_payloads: 'purged_by_retention_within_30_days' },
        })
        .where(eq(schema.erasureRequests.id, req.id));
      report.completed += 1;
    } catch (error) {
      const message = (
        error instanceof Error ? `${error.name}: ${error.message}` : 'non-Error thrown'
      ).slice(0, 500);
      await ctx.service
        .update(schema.erasureRequests)
        .set({ status: 'failed', error: message })
        .where(eq(schema.erasureRequests.id, req.id));
      report.failed += 1;
      ctx.log.error(
        { erasure_request_id: req.id, error: message },
        'erasure failed — runbook erasure-request.md',
      );
    }
  }

  // Overdue = still not completed at due_at. An alert, never a silent miss (Q-06).
  const overdue = await ctx.service
    .select({ id: schema.erasureRequests.id, status: schema.erasureRequests.status })
    .from(schema.erasureRequests)
    .where(
      and(
        lt(schema.erasureRequests.dueAt, now),
        inArray(schema.erasureRequests.status, ['requested', 'in_progress', 'failed']),
      ),
    )
    .limit(100);
  report.overdue = overdue.length;
  if (overdue.length > 0)
    ctx.log.error(
      { overdue: overdue.map((o) => o.id), target_days: ERASURE_COMPLETION_TARGET_DAYS },
      'erasure requests past due',
    );
  return report;
}

export interface RetentionReport {
  readonly tenants: number;
  readonly mediaPurged: number;
  readonly ordersErased: number;
  readonly checkoutsErased: number;
}

export async function runRetentionOnce(ctx: WorkerContext): Promise<RetentionReport> {
  const now = ctx.clock.now();
  const tenants = await ctx.service
    .select({ id: schema.tenants.id, retentionDays: schema.tenants.retentionDays })
    .from(schema.tenants);
  const report = { tenants: tenants.length, mediaPurged: 0, ordersErased: 0, checkoutsErased: 0 };
  for (const t of tenants) {
    const cutoff = addDays(now, -t.retentionDays);
    for (;;) {
      const due = await withTenant(ctx.app, t.id, (tx) =>
        mediaDueForRetention(tx, t.id, cutoff, MEDIA_BATCH),
      );
      if (due.length === 0) break;
      for (const d of due) for (const uri of d.uris) await ctx.recordings.delete(uri);
      const n = await withTenant(ctx.app, t.id, async (tx) => {
        const purged = await markMediaPurged(
          tx,
          t.id,
          due.map((d) => d.attemptId),
          now,
        );
        await audit(tx, {
          tenantId: t.id,
          actorType: 'worker',
          actorId: ctx.workerId,
          action: 'retention.media_purged',
          targetType: 'tenant',
          targetId: t.id,
          after: { attempts: purged, retention_days: t.retentionDays },
        });
        return purged;
      });
      report.mediaPurged += n;
      if (due.length < MEDIA_BATCH) break;
    }
    report.ordersErased += await withTenant(ctx.app, t.id, (tx) =>
      eraseOrdersPlacedBefore(tx, t.id, addDays(now, -ORDER_CACHE_RETENTION_DAYS), now),
    );
    report.checkoutsErased += await withTenant(ctx.app, t.id, (tx) =>
      eraseCheckouts(tx, t.id, { before: addDays(now, -CHECKOUT_RETENTION_DAYS) }, now),
    );
  }
  return report;
}

export async function runRetention(
  ctx: WorkerContext,
  pollMs: number,
  signal: AbortSignal,
): Promise<void> {
  let lastSweep = 0;
  await runLoop({
    name: 'retention',
    log: ctx.log,
    intervalMs: pollMs,
    signal,
    async tick() {
      const e = await runErasuresOnce(ctx);
      if (e.completed + e.failed > 0) ctx.log.info(e, 'erasure pass');
      // The retention sweep is heavy and not urgent: hourly.
      if (Date.now() - lastSweep > 3_600_000) {
        lastSweep = Date.now();
        ctx.log.info(await runRetentionOnce(ctx), 'retention sweep');
      }
    },
  });
}
