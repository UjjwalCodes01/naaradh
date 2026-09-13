import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import { addDays, newId } from '@naaradh/shared';
import type { Redis } from 'ioredis';
import { COMPLAINT_ATTRIBUTION_DAYS } from './constants.js';
import { recordComplaint, suppress, type ComplaintOutcome } from './ledger.js';

/**
 * Complaint intake (P2-CMP-1, E-05). `complaint_reports` is the queue; this turns one report
 * into a counted complaint against the tenant that actually called the number.
 *
 * Runs on the SERVICE role, in one transaction per report: attribution is a cross-tenant
 * question ("who called this number?") and recording may pause a tenant, which only the
 * service role may do (tenants.status is not an app-role column).
 */

export interface Attribution {
  readonly tenantId: string;
  readonly attemptId: string | null;
}

/**
 * The tenant whose outbound call reached this number most recently in the window. A report
 * that already names a tenant (a merchant filing about its own customer) is attributed to it,
 * with the matching attempt linked when there is one.
 */
export async function attributeComplaint(
  tx: Tx,
  input: {
    readonly phoneHash: string;
    readonly reportedAt: Date;
    readonly tenantId: string | null;
  },
): Promise<Attribution | null> {
  const since = addDays(input.reportedAt, -COMPLAINT_ATTRIBUTION_DAYS);
  const [attempt] = await tx
    .select({ tenantId: schema.callAttempts.tenantId, attemptId: schema.callAttempts.id })
    .from(schema.callAttempts)
    .where(
      and(
        eq(schema.callAttempts.phoneHash, input.phoneHash),
        eq(schema.callAttempts.direction, 'outbound'),
        gt(schema.callAttempts.createdAt, since),
        sql`${schema.callAttempts.createdAt} <= ${input.reportedAt}`,
        ...(input.tenantId === null ? [] : [eq(schema.callAttempts.tenantId, input.tenantId)]),
      ),
    )
    .orderBy(desc(schema.callAttempts.createdAt))
    .limit(1);
  if (attempt !== undefined) return { tenantId: attempt.tenantId, attemptId: attempt.attemptId };
  return input.tenantId === null ? null : { tenantId: input.tenantId, attemptId: null };
}

export type ProcessedReport =
  | {
      readonly kind: 'recorded';
      readonly reportId: string;
      readonly complaint: ComplaintOutcome;
      readonly tenantId: string;
    }
  | { readonly kind: 'unattributed'; readonly reportId: string }
  | { readonly kind: 'already_processed'; readonly reportId: string };

/**
 * Process one pending report. The number is always suppressed globally — a complaint is the
 * strongest possible "do not call me" — whether or not a tenant can be blamed for it.
 */
export async function processComplaintReport(
  tx: Tx,
  redis: Redis | null,
  reportId: string,
  at: Date,
): Promise<ProcessedReport> {
  const [report] = await tx
    .select()
    .from(schema.complaintReports)
    .where(eq(schema.complaintReports.id, reportId))
    .for('update')
    .limit(1);
  if (report === undefined || report.status !== 'pending')
    return { kind: 'already_processed', reportId };

  const attribution = await attributeComplaint(tx, {
    phoneHash: report.phoneHash,
    reportedAt: report.reportedAt,
    tenantId: report.tenantId,
  });
  if (attribution === null) {
    await suppress(tx, {
      scope: 'global',
      phoneHash: report.phoneHash,
      purpose: 'all',
      reason: 'complaint',
      at,
      createdBy: `complaint_report:${report.id}`,
      notes: 'unattributed complaint',
    });
    await tx
      .update(schema.complaintReports)
      .set({ status: 'unattributed', processedAt: at })
      .where(eq(schema.complaintReports.id, report.id));
    await tx.insert(schema.auditLog).values({
      id: newId('audit'),
      tenantId: null,
      actorType: 'worker',
      action: 'complaint.unattributed',
      targetType: 'complaint_report',
      targetId: report.id,
      after: { source: report.source, window_days: COMPLAINT_ATTRIBUTION_DAYS },
    });
    return { kind: 'unattributed', reportId: report.id };
  }

  const complaint = await recordComplaint(tx, redis, {
    tenantId: attribution.tenantId,
    phoneHash: report.phoneHash,
    source: report.source,
    at: report.reportedAt,
    attemptId: attribution.attemptId ?? undefined,
    externalRef: report.externalRef ?? undefined,
    notes: report.notes ?? undefined,
  });
  await tx
    .update(schema.complaintReports)
    .set({
      status: 'recorded',
      tenantId: attribution.tenantId,
      complaintId: complaint.id,
      processedAt: at,
    })
    .where(eq(schema.complaintReports.id, report.id));
  return { kind: 'recorded', reportId: report.id, complaint, tenantId: attribution.tenantId };
}

/**
 * Staff decision on a complaint (E-05: "only a human can mark it invalid"). An invalid
 * complaint stops counting, but a tenant it helped pause is NOT resumed automatically — a
 * person decides that separately (`resumeTenant`), with the reason on record.
 */
export async function resolveComplaint(
  tx: Tx,
  input: {
    readonly complaintId: string;
    readonly status: 'valid' | 'invalid';
    readonly by: string;
    readonly notes: string | null;
    readonly at: Date;
  },
): Promise<boolean> {
  const rows = await tx
    .update(schema.complaints)
    .set({
      status: input.status,
      resolvedAt: input.at,
      resolvedBy: input.by,
      ...(input.notes === null ? {} : { notes: input.notes.slice(0, 1000) }),
    })
    .where(eq(schema.complaints.id, input.complaintId))
    .returning({ id: schema.complaints.id, tenantId: schema.complaints.tenantId });
  const row = rows[0];
  if (row === undefined) return false;
  await tx.insert(schema.auditLog).values({
    id: newId('audit'),
    tenantId: row.tenantId,
    actorType: 'user',
    actorId: input.by,
    action: `complaint.${input.status}`,
    targetType: 'complaint',
    targetId: row.id,
  });
  return true;
}

/** Service role only. Resuming a paused tenant is a staff decision with a written reason. */
export async function resumeTenant(
  tx: Tx,
  input: {
    readonly tenantId: string;
    readonly by: string;
    readonly reason: string;
    readonly at: Date;
  },
): Promise<boolean> {
  if (input.reason.trim().length < 10)
    throw new TypeError('a resume reason of at least 10 characters is required');
  const rows = await tx
    .update(schema.tenants)
    .set({ status: 'active', pausedAt: null, pausedReason: null })
    .where(
      and(
        eq(schema.tenants.id, input.tenantId),
        eq(schema.tenants.status, 'paused'),
        sql`${schema.tenants.uninstalledAt} is null`,
      ),
    )
    .returning({ id: schema.tenants.id });
  if (rows.length === 0) return false;
  await tx.insert(schema.auditLog).values({
    id: newId('audit'),
    tenantId: input.tenantId,
    actorType: 'user',
    actorId: input.by,
    action: 'tenant.resumed',
    targetType: 'tenant',
    targetId: input.tenantId,
    after: { reason: input.reason.slice(0, 500) },
  });
  return true;
}
