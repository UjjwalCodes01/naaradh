import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { schema, withTenant } from '@naaradh/db';
import { inboundConcurrencyKey, releaseConcurrency, repairConcurrency } from '@naaradh/compliance';
import { audit, sweepAbandonedCheckouts, sweepAppointmentReminders } from '@naaradh/pipeline';
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
        await finalizeAttempt(
          ctx,
          tx,
          a.tenantId,
          row,
          {
            type: 'call.ended',
            eventId: `reconcile:${a.id}:${now.toISOString()}`,
            ref: { vendor: a.engine, callId: a.engineCallId ?? '' },
            at: snap.endedAt ?? now,
            sequence: null,
            attemptId: a.id,
            reason,
            answeredBy: snap.answeredBy ?? 'unknown',
            durationSec: snap.durationSec ?? 0,
            billableSec: snap.billableSec,
            humanSpeechSec: null,
            recordingUrl: null,
            transcript: null,
            extracted: null,
            detectedLocale: null,
            vendorCost: null,
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
    })
    .from(schema.callAttempts)
    .where(eq(schema.callAttempts.status, 'UNCERTAIN'))
    .limit(100);
  for (const a of uncertain) {
    const found = await ctx.registry.get(a.engine).findCallByIdempotencyKey(a.idempotencyKey);
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
        if (found.status === 'ended' || found.status === 'failed') {
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
              {
                type: 'call.ended',
                eventId: `reconcile:${a.id}:adopted`,
                ref: found.ref,
                at: found.endedAt ?? now,
                sequence: null,
                attemptId: a.id,
                reason: found.endReason ?? 'completed',
                answeredBy: found.answeredBy ?? 'unknown',
                durationSec: found.durationSec ?? 0,
                billableSec: found.billableSec,
                humanSpeechSec: null,
                recordingUrl: null,
                transcript: null,
                extracted: null,
                detectedLocale: null,
                vendorCost: null,
              },
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
      } else if (a.dispatchedAt !== null && a.dispatchedAt < addMinutes(now, -2)) {
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
  for (const eng of ['simulator', ctx.gate.engines.defaultIn, ctx.gate.engines.defaultUs])
    if (!engines.has(eng)) engines.set(eng, 0);
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

export async function runReconcile(
  ctx: WorkerContext,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  await runLoop({
    name: 'reconcile',
    log: ctx.log,
    intervalMs,
    signal,
    async tick() {
      const report = await reconcileOnce(ctx);
      if (Object.values(report).some((n) => n > 0)) ctx.log.info(report, 'reconcile pass');
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
