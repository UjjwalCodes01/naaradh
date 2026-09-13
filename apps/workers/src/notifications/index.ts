import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { schema, withTenant } from '@naaradh/db';
import {
  ALERT_KINDS,
  MailRetryableError,
  alertEmail,
  dailySummaryEmail,
  type AlertKind,
  type Message,
} from '@naaradh/notify';
import { notificationSettingsOf, overview } from '@naaradh/pipeline';
import { inZone, newId } from '@naaradh/shared';
import type { WorkerContext } from '../context.js';

/**
 * notifications worker (P2-WEB-4). Two jobs:
 *
 *   1. Queue each tenant's daily summary once its local clock passes 09:00 — event_id is the
 *      local date, so the unique index makes it once-per-day without any other bookkeeping.
 *   2. Drain `merchant_notifications`: render, send to the account's owners and managers,
 *      retry transient Postmark failures with backoff, give up after 8.
 *
 * Service role (the queue spans tenants); the summary's numbers are computed under withTenant
 * with the app role like any dashboard read. Emails carry counts and links, never customer data.
 */

export const SUMMARY_LOCAL_HOUR = 9;
const MAX_ATTEMPTS = 8;
const LEASE_MINUTES = 10;

export interface NotificationsReport {
  readonly queued: number;
  readonly sent: number;
  readonly skipped: number;
  readonly retried: number;
  readonly dead: number;
}

export async function queueDailySummaries(ctx: WorkerContext, now: Date): Promise<number> {
  const tenants = await ctx.service
    .select({ id: schema.tenants.id, timezone: schema.tenants.timezone })
    .from(schema.tenants)
    .where(inArray(schema.tenants.status, ['active', 'pending_review', 'paused']));
  let queued = 0;
  for (const t of tenants) {
    let local;
    try {
      local = inZone(now, t.timezone);
    } catch {
      local = inZone(now, 'Asia/Kolkata');
    }
    if (local.hour < SUMMARY_LOCAL_HOUR) continue;
    const day = local.toISODate() ?? now.toISOString().slice(0, 10);
    const rows = await ctx.service
      .insert(schema.merchantNotifications)
      .values({
        id: newId('notification'),
        tenantId: t.id,
        kind: 'daily_summary',
        eventId: day,
        data: { day },
        status: 'pending',
        nextAttemptAt: now,
      })
      .onConflictDoNothing({
        target: [
          schema.merchantNotifications.tenantId,
          schema.merchantNotifications.kind,
          schema.merchantNotifications.eventId,
        ],
      })
      .returning({ id: schema.merchantNotifications.id });
    queued += rows.length;
  }
  return queued;
}

async function claim(ctx: WorkerContext, now: Date, batch: number) {
  return ctx.service.transaction(async (tx) => {
    const due = await tx
      .select({ id: schema.merchantNotifications.id })
      .from(schema.merchantNotifications)
      .where(
        and(
          inArray(schema.merchantNotifications.status, ['pending', 'failed']),
          lte(schema.merchantNotifications.nextAttemptAt, now),
        ),
      )
      .orderBy(schema.merchantNotifications.nextAttemptAt)
      .limit(batch)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    // Lease: a crashed worker's rows come back after LEASE_MINUTES on their own.
    return tx
      .update(schema.merchantNotifications)
      .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MINUTES * 60_000) })
      .where(
        inArray(
          schema.merchantNotifications.id,
          due.map((d) => d.id),
        ),
      )
      .returning({
        id: schema.merchantNotifications.id,
        tenantId: schema.merchantNotifications.tenantId,
        kind: schema.merchantNotifications.kind,
        eventId: schema.merchantNotifications.eventId,
        data: schema.merchantNotifications.data,
        attempts: schema.merchantNotifications.attempts,
      });
  });
}

async function settle(
  ctx: WorkerContext,
  id: string,
  set: Partial<typeof schema.merchantNotifications.$inferInsert>,
): Promise<void> {
  await ctx.service
    .update(schema.merchantNotifications)
    .set(set)
    .where(eq(schema.merchantNotifications.id, id));
}

async function render(
  ctx: WorkerContext,
  n: { tenantId: string; kind: string; data: unknown },
  tenant: { name: string; settings: unknown },
  now: Date,
): Promise<((to: string) => Message) | { skip: string }> {
  const data = (n.data ?? {}) as Record<string, unknown>;
  if (n.kind === 'daily_summary') {
    const prefs = notificationSettingsOf(tenant.settings);
    if (!prefs.daily_summary && !prefs.gated_digest) return { skip: 'disabled in settings' };
    const ov = await withTenant(ctx.app, n.tenantId, (tx) => overview(tx, n.tenantId, now, 1));
    if (ov.outbound.orders === 0 && ov.inbound.calls === 0 && ov.ticketsOpen === 0)
      return { skip: 'nothing happened' };
    const day = typeof data['day'] === 'string' ? data['day'] : now.toISOString().slice(0, 10);
    if (!prefs.daily_summary && ov.outbound.gated === 0) return { skip: 'no gated orders' };
    return (to) =>
      dailySummaryEmail({
        to,
        accountName: tenant.name,
        day,
        dashboardUrl: ctx.dashboardUrl,
        outbound: ov.outbound,
        inbound: ov.inbound,
        ticketsOpen: ov.ticketsOpen,
        gatedReasons: prefs.gated_digest
          ? ov.outbound.topGateReasons.map((r) => ({ title: r.title, count: r.count }))
          : null,
      });
  }
  if ((ALERT_KINDS as readonly string[]).includes(n.kind))
    return (to) =>
      alertEmail({
        to,
        accountName: tenant.name,
        kind: n.kind as AlertKind,
        data,
        dashboardUrl: ctx.dashboardUrl,
      });
  return { skip: `unknown kind ${n.kind}` };
}

export async function runNotificationsOnce(
  ctx: WorkerContext,
  batch = 25,
): Promise<NotificationsReport> {
  const now = ctx.clock.now();
  const report = {
    queued: await queueDailySummaries(ctx, now),
    sent: 0,
    skipped: 0,
    retried: 0,
    dead: 0,
  };
  for (const n of await claim(ctx, now, batch)) {
    const [tenant] = await ctx.service
      .select({
        name: schema.tenants.name,
        status: schema.tenants.status,
        settings: schema.tenants.settings,
      })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, n.tenantId))
      .limit(1);
    const recipients = await ctx.service
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.tenantId, n.tenantId),
          inArray(schema.users.role, ['owner', 'manager']),
          isNull(schema.users.disabledAt),
        ),
      );
    const skip = (why: string) =>
      settle(ctx, n.id, {
        status: 'delivered',
        recipients: 0,
        lastError: `skipped: ${why}`,
        sentAt: now,
      });
    if (tenant === undefined || tenant.status === 'uninstalled') {
      await skip('account uninstalled');
      report.skipped += 1;
      continue;
    }
    if (recipients.length === 0) {
      await skip('no owners or managers');
      report.skipped += 1;
      continue;
    }
    let build;
    try {
      build = await render(ctx, n, tenant, now);
    } catch (error) {
      ctx.log.error({ err: error, notification_id: n.id }, 'notification render failed');
      build = null;
    }
    if (build !== null && typeof build !== 'function') {
      await skip(build.skip);
      report.skipped += 1;
      continue;
    }
    let sent = 0;
    let retryable: string | null = build === null ? 'render failed' : null;
    let rejected: string | null = null;
    if (build !== null)
      for (const r of recipients) {
        try {
          await ctx.mailer.send(build(r.email));
          sent += 1;
        } catch (error) {
          const msg = error instanceof Error ? error.message.slice(0, 300) : 'send failed';
          if (error instanceof MailRetryableError) {
            retryable = msg;
            break;
          }
          rejected = msg;
        }
      }
    if (retryable === null) {
      await settle(ctx, n.id, {
        status: 'delivered',
        recipients: sent,
        sentAt: now,
        lastError: rejected,
        attempts: n.attempts + 1,
      });
      report.sent += 1;
      continue;
    }
    const attempts = n.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await settle(ctx, n.id, { status: 'dead', attempts, lastError: retryable });
      ctx.log.error(
        { notification_id: n.id, tenant_id: n.tenantId, kind: n.kind },
        'merchant notification gave up',
      );
      report.dead += 1;
    } else {
      await settle(ctx, n.id, {
        status: 'failed',
        attempts,
        lastError: retryable,
        nextAttemptAt: new Date(now.getTime() + 2 ** attempts * 60_000),
      });
      report.retried += 1;
    }
  }
  return report;
}

export async function runNotifications(
  ctx: WorkerContext,
  pollMs: number,
  signal: AbortSignal,
): Promise<void> {
  ctx.log.info({ poll_ms: pollMs }, 'notifications worker started');
  while (!signal.aborted) {
    try {
      const r = await runNotificationsOnce(ctx);
      if (r.queued + r.sent + r.skipped + r.retried + r.dead > 0)
        ctx.log.info(r, 'notifications pass');
    } catch (error) {
      ctx.log.error({ err: error }, 'notifications pass failed');
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Test/ops helper: how many are waiting. */
export async function pendingNotifications(ctx: WorkerContext): Promise<number> {
  const [r] = await ctx.service
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.merchantNotifications)
    .where(inArray(schema.merchantNotifications.status, ['pending', 'failed']));
  return r?.n ?? 0;
}
