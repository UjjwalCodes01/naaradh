import { asc, eq } from 'drizzle-orm';
import { schema } from '@naaradh/db';
import { processComplaintReport } from '@naaradh/compliance';
import { audit, emitMerchantEvent } from '@naaradh/pipeline';
import type { WorkerContext } from '../context.js';
import { runLoop } from '../loop.js';

/**
 * complaints worker (P2-CMP-1, E-05). Drains `complaint_reports`: attribute each to the tenant
 * that called the number, record it (which may pause the tenant at 3 in 10 days, or trip the
 * global kill at 5), tell the merchant, and raise the alarm. Service role, one transaction per
 * report; a report is locked FOR UPDATE and skipped if another worker already processed it.
 */

export interface ComplaintsReport {
  readonly processed: number;
  readonly recorded: number;
  readonly unattributed: number;
  readonly tenantsPaused: number;
  readonly globalKill: boolean;
}

export async function runComplaintsOnce(ctx: WorkerContext, batch = 20): Promise<ComplaintsReport> {
  const pending = await ctx.service
    .select({ id: schema.complaintReports.id })
    .from(schema.complaintReports)
    .where(eq(schema.complaintReports.status, 'pending'))
    .orderBy(asc(schema.complaintReports.reportedAt))
    .limit(batch);

  const report = {
    processed: 0,
    recorded: 0,
    unattributed: 0,
    tenantsPaused: 0,
    globalKill: false,
  };
  for (const { id } of pending) {
    const now = ctx.clock.now();
    const result = await ctx.service.transaction(async (tx) => {
      const r = await processComplaintReport(tx, ctx.redis, id, now);
      if (r.kind !== 'recorded') return r;
      await audit(tx, {
        tenantId: r.tenantId,
        actorType: 'worker',
        actorId: ctx.workerId,
        action: 'complaint.recorded',
        targetType: 'complaint',
        targetId: r.complaint.id,
        after: {
          report_id: r.reportId,
          tenant_count: r.complaint.tenantCount,
          global_count: r.complaint.globalCount,
        },
      });
      await emitMerchantEvent(tx, r.tenantId, {
        type: 'complaint.received',
        eventId: `${r.complaint.id}:received`,
        at: now,
        data: { complaint_id: r.complaint.id, complaints_in_window: r.complaint.tenantCount },
      });
      if (r.complaint.tenantPaused) {
        await audit(tx, {
          tenantId: r.tenantId,
          actorType: 'worker',
          actorId: ctx.workerId,
          action: 'tenant.auto_paused',
          targetType: 'tenant',
          targetId: r.tenantId,
          after: { reason: 'complaints', count: r.complaint.tenantCount },
        });
        await emitMerchantEvent(tx, r.tenantId, {
          type: 'tenant.paused',
          eventId: `${r.complaint.id}:paused`,
          at: now,
          data: { reason: 'complaints', complaints_in_window: r.complaint.tenantCount },
        });
      }
      return r;
    });
    report.processed += 1;
    if (result.kind === 'unattributed') report.unattributed += 1;
    if (result.kind === 'recorded') {
      report.recorded += 1;
      if (result.complaint.tenantPaused) {
        report.tenantsPaused += 1;
        // Structured error → Error Reporting alert policy (runbook complaint-received.md).
        ctx.log.error(
          {
            tenant_id: result.tenantId,
            complaint_id: result.complaint.id,
            count: result.complaint.tenantCount,
          },
          'tenant auto-paused on complaints (E-05)',
        );
      }
      if (result.complaint.globalKill) {
        report.globalKill = true;
        ctx.log.fatal(
          { complaint_id: result.complaint.id, count: result.complaint.globalCount },
          'GLOBAL KILL SWITCH tripped on complaints (E-05)',
        );
      }
    }
  }
  return report;
}

export async function runComplaints(
  ctx: WorkerContext,
  pollMs: number,
  signal: AbortSignal,
): Promise<void> {
  await runLoop({
    name: 'complaints',
    log: ctx.log,
    intervalMs: pollMs,
    signal,
    async tick() {
      const r = await runComplaintsOnce(ctx);
      if (r.processed > 0) ctx.log.info(r, 'complaints pass');
    },
  });
}
