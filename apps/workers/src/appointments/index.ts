import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { schema, withTenant } from '@naaradh/db';
import { CalendarUnavailable, type CalendarRef } from '@naaradh/calendar';
import { audit } from '@naaradh/pipeline';
import type { WorkerContext } from '../context.js';

/**
 * Appointments that need something said to the provider (ADR-0011 §7). A cancellation decided
 * on a call is recorded at once — the customer is told the truth immediately — but telling
 * Cal.com is a network call, so it happens here, on the reconcile tick, with the error kept on
 * the row while the provider is down. Per tenant, on the app role.
 */
export interface AppointmentSyncReport {
  readonly cancelled: number;
  readonly failed: number;
}

export async function syncAppointmentsOnce(
  ctx: WorkerContext,
  batch = 50,
): Promise<AppointmentSyncReport> {
  const report = { cancelled: 0, failed: 0 };
  const calendars = ctx.calendars;
  const secrets = ctx.secrets;
  if (calendars === undefined) return report;
  const due = await ctx.service
    .select({
      id: schema.appointments.id,
      tenantId: schema.appointments.tenantId,
      calendarId: schema.appointments.calendarId,
      providerRef: schema.appointments.providerRef,
    })
    .from(schema.appointments)
    .where(
      and(
        eq(schema.appointments.status, 'cancelled'),
        isNotNull(schema.appointments.providerRef),
        isNotNull(schema.appointments.calendarId),
        isNull(schema.appointments.providerCancelledAt),
        isNull(schema.appointments.erasedAt),
      ),
    )
    .limit(batch);

  for (const a of due) {
    const now = ctx.clock.now();
    const calendar = await withTenant(ctx.app, a.tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.calendars)
        .where(eq(schema.calendars.id, a.calendarId ?? ''))
        .limit(1);
      return row ?? null;
    });
    // The calendar was removed: there is nobody to tell, and nothing to retry for ever.
    if (calendar === null) {
      await stamp(ctx, a.tenantId, a.id, {
        providerCancelledAt: now,
        providerError: 'calendar_removed',
      });
      continue;
    }

    let credential: string | null = null;
    if (calendar.credentialsSecretRef !== null) {
      try {
        credential = await secrets.resolve(calendar.credentialsSecretRef);
      } catch (error) {
        report.failed += 1;
        await stamp(ctx, a.tenantId, a.id, { providerError: message(error) });
        continue;
      }
    }
    const ref: CalendarRef = {
      id: calendar.id,
      provider: calendar.provider,
      externalId: calendar.externalId,
      timezone: calendar.timezone,
      slotMinutes: calendar.slotMinutes,
      config: (calendar.config ?? {}) as Record<string, unknown>,
      credential,
    };
    try {
      await calendars.get(calendar.provider).cancel({
        calendar: ref,
        providerRef: a.providerRef ?? '',
        reason: 'cancelled by the customer on a Naaradh call',
      });
    } catch (error) {
      // Transient → the next tick tries again; anything else → stamped, so it stops retrying.
      const transient = error instanceof CalendarUnavailable;
      report.failed += 1;
      await stamp(ctx, a.tenantId, a.id, {
        providerError: message(error),
        ...(transient ? {} : { providerCancelledAt: now }),
      });
      ctx.log.warn(
        { appointment_id: a.id, tenant_id: a.tenantId, err: message(error), transient },
        'appointment cancellation not delivered to the calendar provider',
      );
      continue;
    }
    await withTenant(ctx.app, a.tenantId, async (tx) => {
      await tx
        .update(schema.appointments)
        .set({ providerCancelledAt: now, providerError: null })
        .where(eq(schema.appointments.id, a.id));
      await audit(tx, {
        tenantId: a.tenantId,
        actorType: 'worker',
        actorId: ctx.workerId,
        action: 'appointment.provider_cancelled',
        targetType: 'appointment',
        targetId: a.id,
        after: { provider: calendar.provider, provider_ref: a.providerRef },
      });
    });
    report.cancelled += 1;
  }
  return report;
}

const message = (error: unknown) =>
  (error instanceof Error ? error.message : 'unknown error').slice(0, 300);

async function stamp(
  ctx: WorkerContext,
  tenantId: string,
  appointmentId: string,
  set: { providerError?: string | null; providerCancelledAt?: Date },
): Promise<void> {
  await withTenant(ctx.app, tenantId, (tx) =>
    tx.update(schema.appointments).set(set).where(eq(schema.appointments.id, appointmentId)),
  );
}
