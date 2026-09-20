import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { schema, withTenant } from '@naaradh/db';
import {
  REQUIRED_DNC_LISTS,
  inboundConcurrencyKey,
  releaseConcurrency,
  repairConcurrency,
} from '@naaradh/compliance';
import { audit, sweepAbandonedCheckouts, sweepAppointmentReminders } from '@naaradh/pipeline';
import { endedFromSnapshot } from '@naaradh/engines-core';
import { addMinutes } from '@naaradh/shared';
import type { WorkerContext } from '../context.js';
import { runCliHealthDaily } from '../cli-health/index.js';
import { runQaWeekly } from '../qa/index.js';
import { syncAppointmentsOnce } from '../appointments/index.js';
import { runLoop } from '../loop.js';
import { releaseStaleClaims } from '../dispatcher/claim.js';
import { finalizeAttempt, type AttemptRow } from '../results/finalize.js';
import { reconcileShopifyOrders } from './shopify-orders.js';

/**
 * reconcile (AGENTS §3, E-21, E-53 partial). Cross-tenant sweeps, every minute:
 *
 *   stale claims        DISPATCHING > 2 min with no live attempt → back to SCHEDULED
 *   stuck attempts      live > maxDuration + 60 s → ask the engine (fetchCall) and finalize
 *   uncertain dispatch  UNCERTAIN → findCallByIdempotencyKey → adopt or fail
 *   expiry              waiting intents past not_after → EXPIRED
 *   concurrency repair  counters rebuilt from the live-attempt query
 *   payload retention   webhook_events.payload nulled after 30 days
 *   abandoned checkouts idle 45 min + consent → one abandoned-cart intent (ADR-0010 §1)
 *   appointments        starting within 24 h → one confirmation call (ADR-0011 §7); a
 *                       cancellation decided on a call is pushed to the calendar provider
 *
 *   shopify orders      hourly: orders the webhooks missed (E-53, reconcile/shopify-orders.ts)
 */
export interface ReconcileReport {
  staleClaims: number;
  stuckAttempts: number;
  uncertainResolved: number;
  expired: number;
  payloadsPurged: number;
}

export async function reconcileOnce(ctx: WorkerContext): Promise<ReconcileReport> {
  const now = ctx.clock.now();
  const report: ReconcileReport = {
    staleClaims: 0,
    stuckAttempts: 0,
    uncertainResolved: 0,
    expired: 0,
    payloadsPurged: 0,
  };

  report.staleClaims = await releaseStaleClaims(ctx.service, addMinutes(now, -2));

  // ---- stuck attempts (E-21) ---------------------------------------------------------------
  const stuck = await ctx.service
    .select({
      id: schema.callAttempts.id,
      tenantId: schema.callAttempts.tenantId,
      engine: schema.callAttempts.engine,
      engineCallId: schema.callAttempts.engineCallId,
      status: schema.callAttempts.status,
    })
    .from(schema.callAttempts)
    .where(
      and(
        inArray(schema.callAttempts.status, [
          'DIALING',
          'RINGING',
          'IN_CONVERSATION',
          'TRANSFERRING',
        ]),
        sql`coalesce(${schema.callAttempts.lastEventAt}, ${schema.callAttempts.dispatchedAt}, ${schema.callAttempts.createdAt}) < ${now}::timestamptz - make_interval(secs => ${schema.callAttempts.maxDurationSec} + 60)`,
      ),
    )
    .limit(100);
  for (const a of stuck) {
    if (a.engineCallId === null) continue;
    const snap = await ctx.registry
      .get(a.engine)
      .fetchCall({ vendor: a.engine, callId: a.engineCallId });
    await withTenant(ctx.app, a.tenantId, async (tx) => {
      const row = await loadAttempt(tx, a.id);
      if (row === null) return;
      if (snap.status === 'ended' || snap.status === 'failed' || snap.status === 'not_found') {
        const reason =
          snap.endReason ?? (snap.status === 'not_found' ? 'engine_error' : 'completed');
        // The vendor has ended the call but is still writing its transcript and extraction:
        // wait (up to ten minutes) rather than record an answered call as inconclusive.
        if (
          snap.status === 'ended' &&
          snap.result === null &&
          (snap.endedAt === null || snap.endedAt > addMinutes(now, -10))
        )
          return;
        await finalizeAttempt(
          ctx,
          tx,
          a.tenantId,
          row,
          {
            ...endedFromSnapshot(
              { ...snap, ref: { vendor: a.engine, callId: a.engineCallId ?? '' } },
              { eventId: `reconcile:${a.id}:${now.toISOString()}`, attemptId: a.id, at: now },
            ),
            reason,
          },
          { signatureValid: true },
        );
        await audit(tx, {
          tenantId: a.tenantId,
          actorType: 'worker',
          action: 'attempt.reconciled',
          targetType: 'call_attempt',
          targetId: a.id,
          after: { engine_status: snap.status, reason },
        });
        report.stuckAttempts += 1;
      } else {
        // Still in progress per the engine: extend the deadline rather than guess.
        await tx
          .update(schema.callAttempts)
          .set({ lastEventAt: now })
          .where(eq(schema.callAttempts.id, a.id));
      }
    });
  }

  // ---- uncertain dispatches (AGENTS §5.3) ------------------------------------------------------
  const uncertain = await ctx.service
    .select({
      id: schema.callAttempts.id,
      tenantId: schema.callAttempts.tenantId,
      engine: schema.callAttempts.engine,
      idempotencyKey: schema.callAttempts.idempotencyKey,
      intentId: schema.callAttempts.intentId,
      dispatchedAt: schema.callAttempts.dispatchedAt,
      maxDurationSec: schema.callAttempts.maxDurationSec,
    })
    .from(schema.callAttempts)
    .where(eq(schema.callAttempts.status, 'UNCERTAIN'))
    .limit(100);
  for (const a of uncertain) {
    const engine = ctx.registry.get(a.engine);
    const found = await engine.findCallByIdempotencyKey(a.idempotencyKey);
    // An engine that cannot look a call up proves nothing by not finding it: if the call exists
    // its post-call webhook finalizes this attempt (it carries our attempt id), so wait for the
    // longest the call could last before concluding it never existed.
    const graceMin = engine.capabilities().callLookup ? 2 : Math.ceil(a.maxDurationSec / 60) + 5;
    await withTenant(ctx.app, a.tenantId, async (tx) => {
      if (found !== null) {
        // The call exists: adopt it. Terminal already → finalize from the snapshot.
        await tx
          .update(schema.callAttempts)
          .set({
            engineCallId: found.ref.callId,
            status:
              found.status === 'ended' || found.status === 'failed' ? 'IN_CONVERSATION' : 'DIALING',
            lastEventAt: now,
          })
          .where(eq(schema.callAttempts.id, a.id));
        // Still being post-processed by the vendor → the stuck-attempt pass finishes it.
        const pending =
          found.status === 'ended' &&
          found.result === null &&
          (found.endedAt === null || found.endedAt > addMinutes(now, -10));
        if ((found.status === 'ended' || found.status === 'failed') && !pending) {
          const row = await loadAttempt(tx, a.id);
          if (row !== null) {
            await finalizeAttempt(
              ctx,
              tx,
              a.tenantId,
              {
                ...row,
                answeredBy: found.answeredBy,
                aiDisclosedAt: row.aiDisclosedAt ?? found.startedAt,
                recordingDisclosedAt: row.recordingDisclosedAt ?? found.startedAt,
              },
              endedFromSnapshot(found, {
                eventId: `reconcile:${a.id}:adopted`,
                attemptId: a.id,
                at: now,
              }),
              { signatureValid: true },
            );
          }
        }
        await audit(tx, {
          tenantId: a.tenantId,
          actorType: 'worker',
          action: 'attempt.uncertain_adopted',
          targetType: 'call_attempt',
          targetId: a.id,
          after: { engine_call_id: found.ref.callId, engine_status: found.status },
        });
        report.uncertainResolved += 1;
      } else if (a.dispatchedAt !== null && a.dispatchedAt < addMinutes(now, -graceMin)) {
        // Existence disproven: safe to fail the attempt and let the intent try again.
        await releaseConcurrency(ctx.redis, a.tenantId, a.engine);
        await tx
          .update(schema.callAttempts)
          .set({
            status: 'FAILED',
            endReason: 'dispatch_uncertain_not_found',
            endedAt: now,
            lastEventAt: now,
          })
          .where(eq(schema.callAttempts.id, a.id));
        if (a.intentId !== null) {
          await tx
            .update(schema.callIntents)
            .set({
              status: 'SCHEDULED',
              nextAttemptAt: now,
              attemptsCount: sql`greatest(${schema.callIntents.attemptsCount} - 1, 0)`,
            })
            .where(
              and(
                eq(schema.callIntents.id, a.intentId),
                eq(schema.callIntents.status, 'IN_PROGRESS'),
                sql`${schema.callIntents.notAfter} > ${now}`,
              ),
            );
        }
        await audit(tx, {
          tenantId: a.tenantId,
          actorType: 'worker',
          action: 'attempt.uncertain_not_found',
          targetType: 'call_attempt',
          targetId: a.id,
        });
        report.uncertainResolved += 1;
      }
    });
  }

  // ---- expiry ------------------------------------------------------------------------------------
  const expired = await ctx.service
    .update(schema.callIntents)
    .set({
      status: 'EXPIRED',
      gatedReason: 'intent:expired',
      nextAttemptAt: null,
      completedAt: now,
    })
    .where(
      and(
        inArray(schema.callIntents.status, ['CREATED', 'SCHEDULED', 'RETRY_SCHEDULED']),
        lt(schema.callIntents.notAfter, now),
      ),
    )
    .returning({ id: schema.callIntents.id, tenantId: schema.callIntents.tenantId });
  for (const e of expired) {
    await withTenant(ctx.app, e.tenantId, (tx) =>
      audit(tx, {
        tenantId: e.tenantId,
        actorType: 'worker',
        action: 'intent.expired',
        targetType: 'call_intent',
        targetId: e.id,
      }),
    );
  }
  report.expired = expired.length;

  // ---- concurrency repair --------------------------------------------------------------------------
  const live = await ctx.service
    .select({
      tenantId: schema.callAttempts.tenantId,
      engine: schema.callAttempts.engine,
      direction: schema.callAttempts.direction,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.callAttempts)
    .where(
      inArray(schema.callAttempts.status, [
        'DISPATCHING',
        'UNCERTAIN',
        'DIALING',
        'RINGING',
        'IN_CONVERSATION',
        'TRANSFERRING',
      ]),
    )
    .groupBy(
      schema.callAttempts.tenantId,
      schema.callAttempts.engine,
      schema.callAttempts.direction,
    );
  // Inbound slots are counted under their own key (admitInbound) so answering never eats outbound capacity.
  const tenants = new Map<string, number>();
  const engines = new Map<string, number>();
  for (const row of live) {
    const key = row.direction === 'inbound' ? inboundConcurrencyKey(row.tenantId) : row.tenantId;
    tenants.set(key, (tenants.get(key) ?? 0) + row.n);
    engines.set(row.engine, (engines.get(row.engine) ?? 0) + row.n);
  }
  // Tenants/engines with zero live calls must be reset too, or a leak persists forever.
  const known = await ctx.service
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(eq(schema.tenants.status, 'active'));
  for (const t of known) {
    if (!tenants.has(t.id)) tenants.set(t.id, 0);
    if (!tenants.has(inboundConcurrencyKey(t.id))) tenants.set(inboundConcurrencyKey(t.id), 0);
  }
  // Every configured engine, secondaries included: a leaked slot on a failover engine would
  // otherwise never be repaired.
  for (const eng of [
    'simulator',
    ctx.gate.engines.defaultIn,
    ctx.gate.engines.defaultUs,
    ctx.gate.engines.secondaryIn,
    ctx.gate.engines.secondaryUs,
  ])
    if (eng !== null && !engines.has(eng)) engines.set(eng, 0);
  await repairConcurrency(ctx.redis, { tenants, engines });

  // ---- webhook payload retention (30 days) -------------------------------------------------------------
  const purged = await ctx.service
    .update(schema.webhookEvents)
    .set({ payload: null })
    .where(
      and(
        lt(schema.webhookEvents.receivedAt, addMinutes(now, -30 * 24 * 60)),
        sql`${schema.webhookEvents.payload} is not null`,
      ),
    )
    .returning({ id: schema.webhookEvents.id });
  report.payloadsPurged = purged.length;

  return report;
}

async function loadAttempt(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  id: string,
): Promise<AttemptRow | null> {
  const [row] = await tx
    .select({
      id: schema.callAttempts.id,
      intentId: schema.callAttempts.intentId,
      direction: schema.callAttempts.direction,
      contactId: schema.callAttempts.contactId,
      phoneHash: schema.callAttempts.phoneHash,
      purpose: schema.callAttempts.purpose,
      externalRef: schema.callAttempts.externalRef,
      attemptNo: schema.callAttempts.attemptNo,
      engine: schema.callAttempts.engine,
      status: schema.callAttempts.status,
      answeredBy: schema.callAttempts.answeredBy,
      answeredAt: schema.callAttempts.answeredAt,
      aiDisclosedAt: schema.callAttempts.aiDisclosedAt,
      recordingDisclosedAt: schema.callAttempts.recordingDisclosedAt,
      scriptId: schema.callAttempts.scriptId,
    })
    .from(schema.callAttempts)
    .where(and(eq(schema.callAttempts.id, id), isNull(schema.callAttempts.endedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * A missing or stale national do-not-call list stops every marketing call to that country
 * (the gate fails closed, quietly). Say so where an alert can hear it — and five days BEFORE a
 * list expires, while there is still time to reload it (docs/runbooks/dnc-registry.md).
 */
export async function checkDncRegistries(ctx: WorkerContext): Promise<string[]> {
  const regions = ctx.dndRegistryRegions ?? [];
  if (regions.length === 0) return [];
  const now = ctx.clock.now();
  const lists = await ctx.service.select().from(schema.dncRegistryLists);
  const problems: string[] = [];
  for (const region of regions) {
    for (const name of REQUIRED_DNC_LISTS[region] ?? []) {
      const l = lists.find((x) => x.list === name);
      if (l === undefined || l.loadedAt === null || l.activeVersion === null) {
        problems.push(`${name}:missing`);
        continue;
      }
      const ageDays = (now.getTime() - l.loadedAt.getTime()) / 86_400_000;
      if (ageDays > l.maxAgeDays) problems.push(`${name}:stale`);
      else if (ageDays > l.maxAgeDays - 5) problems.push(`${name}:expires_soon`);
    }
  }
  for (const l of lists)
    if (
      !l.required &&
      l.loadedAt !== null &&
      (now.getTime() - l.loadedAt.getTime()) / 86_400_000 > l.maxAgeDays
    )
      problems.push(`${l.list}:stale`);
  if (problems.length > 0)
    ctx.log.warn({ lists: problems }, 'dnc registry missing or stale: marketing calls refused');
  return problems;
}

export async function runReconcile(
  ctx: WorkerContext,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  let lastDncCheck = 0;
  await runLoop({
    name: 'reconcile',
    log: ctx.log,
    intervalMs,
    signal,
    async tick() {
      const report = await reconcileOnce(ctx);
      if (Object.values(report).some((n) => n > 0)) ctx.log.info(report, 'reconcile pass');
      // Hourly is plenty: the lists change every few weeks.
      if (Date.now() - lastDncCheck > 3_600_000) {
        lastDncCheck = Date.now();
        await checkDncRegistries(ctx);
      }
      const shopify = await reconcileShopifyOrders(ctx);
      if (shopify !== null && shopify.stores > 0) ctx.log.info(shopify, 'shopify reconcile pass');
      // ADR-0010 §1: every minute, so a checkout is called within ~46 minutes of going quiet.
      const sweep = await sweepAbandonedCheckouts(ctx.service, ctx.app, ctx.keys, ctx.clock.now());
      if (sweep.considered > 0) ctx.log.info(sweep, 'abandoned checkout sweep');
      // ADR-0011 §7: reminders for appointments starting inside the next 24 hours.
      const reminders = await sweepAppointmentReminders(
        ctx.service,
        ctx.app,
        ctx.keys,
        ctx.clock.now(),
        undefined,
        ctx.dataRegion,
      );
      if (reminders.considered > 0) ctx.log.info(reminders, 'appointment reminder sweep');
      const calendarSync = await syncAppointmentsOnce(ctx);
      if (calendarSync.cancelled + calendarSync.failed > 0)
        ctx.log.info(calendarSync, 'appointment calendar sync');
      // Daily number health (E-28) rides on the reconcile role: no extra service to run.
      await runCliHealthDaily(ctx, ctx.clock.now());
      const qa = await runQaWeekly(ctx, ctx.clock.now());
      if (qa !== null) ctx.log.info(qa, 'weekly QA sample');
    },
  });
}
