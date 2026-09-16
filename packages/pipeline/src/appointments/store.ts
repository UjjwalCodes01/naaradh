import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { schema, withTenant, type Db, type DbOrTx } from '@naaradh/db';
import { USE_CASE_WINDOWS, recordConsent, type ConsentSource } from '@naaradh/compliance';
import { addMinutes, newId, type PhoneRegion } from '@naaradh/shared';
import { audit } from '../audit.js';
import { cancelIntents } from '../cancel.js';
import { upsertContact, type PhoneKeys } from '../contacts.js';
import { createIntent } from '../intents.js';

/**
 * Appointments (ADR-0011 §7). The row is the fact; the reminder call is derived from it. A
 * merchant's system, a provider or the agent on a call all write the same row, and the sweep
 * turns a future appointment into exactly one `appointment_confirm` intent inside the existing
 * envelope (24 h to 2 h before, recipient's zone, 09:00–21:00 — invariant 3 still wins).
 *
 * Nothing here holds a reason for a visit or any clinical detail: a service name, a time, a
 * phone hash and a contact link (ADR-0011 §8).
 */

export type AppointmentStatus = (typeof schema.appointmentStatus.enumValues)[number];

export interface AppointmentInput {
  readonly tenantId: string;
  /** `api`, a provider name, or `voice` when the agent booked it. */
  readonly source: string;
  readonly externalId: string;
  readonly calendarId?: string | null;
  readonly rawPhone: string | null;
  readonly defaultRegion: PhoneRegion;
  readonly customerName?: string | null;
  readonly service: string | null;
  readonly startsAt: Date;
  readonly endsAt?: Date | null;
  readonly timezone: string;
  readonly status?: AppointmentStatus;
  readonly providerRef?: string | null;
  readonly bookedByAttemptId?: string | null;
  /** When the caller is already a contact (a voice booking): no number is needed or wanted. */
  readonly existingContact?: { readonly contactId: string; readonly phoneHash: string };
  /**
   * How the customer asked for this appointment. A reminder is a SERVICE call, and India (and
   * the EU) want a consent row for one — without this, the reminder is refused
   * `consent:missing`, which is the gate doing its job, not a bug to work around. The merchant
   * supplies it with the appointment; the agent supplies `verbal` when it books on a call.
   */
  readonly consent?: {
    readonly source: ConsentSource;
    readonly evidenceUri?: string | undefined;
    readonly wordingVersion?: string | undefined;
  };
  readonly now: Date;
}

export type AppointmentResult =
  | { readonly kind: 'recorded'; readonly appointmentId: string; readonly created: boolean }
  | { readonly kind: 'skipped'; readonly reason: 'no_phone' | 'erased' };

/**
 * Create or update one appointment. Idempotent on (tenant, source, external id): the merchant's
 * nightly sync can replay the same appointment for ever. Moving the time clears the reminder so
 * the sweep re-decides it; cancelling cancels a queued call (E-133).
 */
export async function upsertAppointment(
  tx: DbOrTx,
  keys: PhoneKeys,
  input: AppointmentInput,
): Promise<AppointmentResult> {
  let contactId: string | null = input.existingContact?.contactId ?? null;
  let phoneHash: string | null = input.existingContact?.phoneHash ?? null;
  // The consent (and the calling window) follow the RECIPIENT's region, invariant 2.
  let region: string = input.defaultRegion;
  if (input.existingContact !== undefined) {
    const [c] = await tx
      .select({ region: schema.contacts.region })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, input.existingContact.contactId))
      .limit(1);
    region = c?.region ?? input.defaultRegion;
  }
  if (input.rawPhone !== null && input.rawPhone.trim().length > 0) {
    const c = await upsertContact(tx, keys, {
      tenantId: input.tenantId,
      rawPhone: input.rawPhone,
      defaultRegion: input.defaultRegion,
      name: input.customerName ?? null,
      timezone: input.timezone,
      source: `${input.source}:appointment`,
      at: input.now,
    });
    if (c.ok && c.erased) return { kind: 'skipped', reason: 'erased' };
    if (c.ok) {
      contactId = c.contactId;
      phoneHash = c.phoneHash;
      region = c.phone.region;
    }
  }
  // Without a number there is nobody to call; the appointment is still worth recording for the
  // support line ("do I have an appointment?"), so it is only the reminder that is impossible.
  const status = input.status ?? 'scheduled';

  const [existing] = await tx
    .select()
    .from(schema.appointments)
    .where(
      and(
        eq(schema.appointments.tenantId, input.tenantId),
        eq(schema.appointments.source, input.source),
        eq(schema.appointments.externalId, input.externalId),
      ),
    )
    .for('update')
    .limit(1);

  // The consent is recorded before the row, so a failure to record cannot leave an appointment
  // that looks callable. Idempotent by (phone, purpose, external ref, source) at the ledger.
  if (input.consent !== undefined && phoneHash !== null)
    await recordServiceConsent(tx, {
      tenantId: input.tenantId,
      phoneHash,
      region,
      externalRef: input.externalId,
      capturedAt: input.now,
      consent: input.consent,
    });

  if (existing === undefined) {
    const id = newId('appointment');
    await tx.insert(schema.appointments).values({
      id,
      tenantId: input.tenantId,
      calendarId: input.calendarId ?? null,
      contactId,
      phoneHash,
      source: input.source,
      externalId: input.externalId,
      service: input.service,
      startsAt: input.startsAt,
      endsAt: input.endsAt ?? null,
      timezone: input.timezone,
      status,
      providerRef: input.providerRef ?? null,
      bookedByAttemptId: input.bookedByAttemptId ?? null,
    });
    await audit(tx, {
      tenantId: input.tenantId,
      actorType: 'worker',
      action: 'appointment.created',
      targetType: 'appointment',
      targetId: id,
      after: { source: input.source, starts_at: input.startsAt.toISOString(), status },
    });
    return { kind: 'recorded', appointmentId: id, created: true };
  }

  if (existing.erasedAt !== null) return { kind: 'skipped', reason: 'erased' };
  const moved = existing.startsAt.getTime() !== input.startsAt.getTime();
  const gone = status === 'cancelled';
  await tx
    .update(schema.appointments)
    .set({
      calendarId: input.calendarId ?? existing.calendarId,
      contactId: contactId ?? existing.contactId,
      phoneHash: phoneHash ?? existing.phoneHash,
      service: input.service ?? existing.service,
      startsAt: input.startsAt,
      endsAt: input.endsAt ?? existing.endsAt,
      timezone: input.timezone,
      status,
      providerRef: input.providerRef ?? existing.providerRef,
      // A moved or cancelled appointment gives up its reminder: the sweep decides again.
      ...(moved || gone ? { intentId: null, reminderSweptAt: null } : {}),
    })
    .where(eq(schema.appointments.id, existing.id));

  if ((moved || gone) && existing.intentId !== null) {
    await cancelIntents(tx, {
      tenantId: input.tenantId,
      intentId: existing.intentId,
      reason: gone ? 'appointment_cancelled' : 'appointment_moved',
      at: input.now,
      actor: { type: 'worker', id: 'appointments' },
    });
  }
  if (moved || gone || existing.status !== status)
    await audit(tx, {
      tenantId: input.tenantId,
      actorType: 'worker',
      action: gone ? 'appointment.cancelled' : moved ? 'appointment.moved' : 'appointment.updated',
      targetType: 'appointment',
      targetId: existing.id,
      before: { starts_at: existing.startsAt.toISOString(), status: existing.status },
      after: { starts_at: input.startsAt.toISOString(), status },
    });
  return { kind: 'recorded', appointmentId: existing.id, created: false };
}

/** One live service grant per (phone, appointment, source): a nightly re-sync adds nothing. */
async function recordServiceConsent(
  tx: DbOrTx,
  input: {
    readonly tenantId: string;
    readonly phoneHash: string;
    readonly region: string;
    readonly externalRef: string;
    readonly capturedAt: Date;
    readonly consent: {
      readonly source: ConsentSource;
      readonly evidenceUri?: string | undefined;
      readonly wordingVersion?: string | undefined;
    };
  },
): Promise<void> {
  const [already] = await tx
    .select({ id: schema.consents.id })
    .from(schema.consents)
    .where(
      and(
        eq(schema.consents.tenantId, input.tenantId),
        eq(schema.consents.phoneHash, input.phoneHash),
        eq(schema.consents.action, 'grant'),
        eq(schema.consents.purpose, 'service'),
        eq(schema.consents.externalRef, input.externalRef),
        sql`not exists (select 1 from consents r where r.action = 'revoke' and r.grant_id = ${schema.consents.id})`,
      ),
    )
    .limit(1);
  if (already !== undefined) return;
  await recordConsent(tx, {
    tenantId: input.tenantId,
    phoneHash: input.phoneHash,
    purpose: 'service',
    source: input.consent.source,
    recipientRegion: input.region,
    capturedAt: input.capturedAt,
    externalRef: input.externalRef,
    evidenceUri: input.consent.evidenceUri,
    wordingVersion: input.consent.wordingVersion,
    context: { surface: 'appointment' },
  });
}

export interface ReminderReport {
  readonly considered: number;
  readonly scheduled: number;
  readonly skipped: Readonly<Record<string, number>>;
}

/**
 * The reminder sweep (reconcile worker). Cross-tenant candidates are listed with the SERVICE
 * role; each appointment is decided inside its tenant's transaction on the APP role, where RLS
 * applies and `for update skip locked` keeps two instances apart.
 *
 * An appointment enters the window `notBefore` (-24 h) before it starts, so the sweep looks for
 * appointments starting within the next 24 hours that have no intent yet. One that is already
 * inside the last 2 hours is too late (E-134) and is marked swept without a call.
 */
export async function sweepAppointmentReminders(
  service: Db,
  app: Db,
  keys: PhoneKeys,
  now: Date,
  limit = 200,
): Promise<ReminderReport> {
  const window = USE_CASE_WINDOWS.appointment_confirm;
  const horizon = addMinutes(now, -window.notBeforeMinutes);
  const candidates = await service
    .select({ id: schema.appointments.id, tenantId: schema.appointments.tenantId })
    .from(schema.appointments)
    .where(
      and(
        sql`${schema.appointments.status} in ('scheduled','rescheduled')`,
        isNull(schema.appointments.intentId),
        isNull(schema.appointments.erasedAt),
        isNull(schema.appointments.reminderSweptAt),
        lt(schema.appointments.startsAt, horizon),
      ),
    )
    .orderBy(schema.appointments.startsAt)
    .limit(limit);

  const report = {
    considered: candidates.length,
    scheduled: 0,
    skipped: {} as Record<string, number>,
  };
  for (const c of candidates) {
    const decision = await withTenant(app, c.tenantId, (tx) => decideReminder(tx, keys, c.id, now));
    if (decision === 'scheduled') report.scheduled += 1;
    else if (decision !== 'locked') report.skipped[decision] = (report.skipped[decision] ?? 0) + 1;
  }
  return report;
}

async function decideReminder(
  tx: DbOrTx,
  keys: PhoneKeys,
  appointmentId: string,
  now: Date,
): Promise<string> {
  const [a] = await tx
    .select()
    .from(schema.appointments)
    .where(and(eq(schema.appointments.id, appointmentId), isNull(schema.appointments.intentId)))
    .for('update', { skipLocked: true })
    .limit(1);
  if (a === undefined) return 'locked';

  const mark = async (reason: string): Promise<string> => {
    await tx
      .update(schema.appointments)
      .set({ reminderSweptAt: now })
      .where(eq(schema.appointments.id, a.id));
    return reason;
  };

  if (a.status === 'cancelled' || a.status === 'completed' || a.status === 'no_show')
    return mark(`status_${a.status}`);
  if (a.phoneHash === null || a.contactId === null) return mark('no_phone');
  // E-134: inside the last two hours there is no useful call left to place.
  const window = USE_CASE_WINDOWS.appointment_confirm;
  if (a.startsAt <= addMinutes(now, -window.notAfterMinutes)) return mark('too_late');

  const [contact] = await tx
    .select({
      name: schema.contacts.name,
      region: schema.contacts.region,
      erasedAt: schema.contacts.erasedAt,
    })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, a.contactId))
    .limit(1);
  const [tenant] = await tx
    .select({ name: schema.tenants.name })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, a.tenantId))
    .limit(1);
  const [calendar] =
    a.calendarId === null
      ? []
      : await tx
          .select({ name: schema.calendars.name })
          .from(schema.calendars)
          .where(eq(schema.calendars.id, a.calendarId))
          .limit(1);

  const local = a.startsAt.toLocaleString('en-IN', {
    timeZone: a.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  });
  const [date = '', time = ''] = local.split(' at ');

  const result = await createIntent(tx, keys, {
    tenantId: a.tenantId,
    useCase: 'appointment_confirm',
    source: a.source === 'calcom' ? 'calcom' : 'api',
    account: `${a.source}:appointment`,
    // The ref carries the time the call is FOR: a second sweep of the same appointment at the
    // same time is a duplicate (E-115 analogue), while a moved appointment is a different call
    // and must be allowed to get one (E-133).
    externalRef: `${a.externalId}@${a.startsAt.toISOString()}`,
    eventTs: now,
    // The envelope is measured from the appointment, not from now (USE_CASE_WINDOWS).
    appointmentTs: a.startsAt,
    rawPhone: null,
    defaultRegion: (contact?.region ?? 'IN') as PhoneRegion,
    existingContact: {
      contactId: a.contactId,
      phoneHash: a.phoneHash,
      region: contact?.region ?? 'IN',
      erased: contact?.erasedAt !== null && contact?.erasedAt !== undefined,
    },
    timezone: a.timezone,
    variables: {
      customer_name: contact?.name ?? '',
      brand: tenant?.name ?? '',
      service: a.service ?? calendar?.name ?? '',
      date,
      time,
    },
    now,
    actor: { type: 'worker', id: 'appointment-reminders' },
  });

  if (result.status === 'skipped') return mark(result.reason);
  if (result.status === 'duplicate') return mark('already_handled');
  const intentId = 'intentId' in result ? result.intentId : null;
  await tx
    .update(schema.appointments)
    .set({ intentId, reminderSweptAt: now })
    .where(eq(schema.appointments.id, a.id));
  return result.status === 'gated' ? result.reason : 'scheduled';
}

/** Erasure / retention: the appointment keeps its time, loses the person (E-119 analogue). */
export async function eraseAppointments(
  tx: DbOrTx,
  tenantId: string,
  where: { readonly phoneHash: string } | { readonly all: true } | { readonly before: Date },
  at: Date,
): Promise<number> {
  const scope =
    'phoneHash' in where
      ? eq(schema.appointments.phoneHash, where.phoneHash)
      : 'before' in where
        ? lt(schema.appointments.startsAt, where.before)
        : sql`true`;
  const rows = await tx
    .update(schema.appointments)
    .set({ phoneHash: null, contactId: null, erasedAt: at })
    .where(
      and(eq(schema.appointments.tenantId, tenantId), isNull(schema.appointments.erasedAt), scope),
    )
    .returning({ id: schema.appointments.id });
  return rows.length;
}
