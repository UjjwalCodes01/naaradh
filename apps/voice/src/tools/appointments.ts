import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema } from '@naaradh/db';
import { CalendarUnavailable, SlotTaken, type CalendarRef } from '@naaradh/calendar';
import { audit, emitMerchantEvent, upsertAppointment } from '@naaradh/pipeline';
import { sanitiseMerchantText } from '@naaradh/scripts';
import { addDays } from '@naaradh/shared';
import { fail, ok, type HandlerOutcome, type ToolCtx } from './types.js';

/**
 * The appointment tools (ADR-0011 §6). Two rules decide everything here:
 *
 *   1. A time the agent may offer came from `get_slots`, which came from the merchant's
 *      calendar. `book_slot` accepts only a slot id this same call was offered (E-132), so the
 *      model cannot invent, round or "remember" a time.
 *   2. Only the provider decides a booking happened. `book_slot` says ok only after the
 *      provider confirmed; a slot taken in between is refused with the truth (E-130).
 *
 * The appointment is always for the number the call is on (E-131): an appointment for somebody
 * else is a ticket, which the prompt rules tell the agent to create.
 */

const MAX_SLOTS_OFFERED = 3;
const DEFAULT_DAYS_AHEAD = 7;

/** How the caller hears a slot. Rendered here, so the model never formats a time itself. */
function spokenTime(startsAt: Date, timezone: string, locale: string): string {
  return startsAt.toLocaleString(locale === 'hi-IN' ? 'en-IN' : 'en-IN', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  });
}

async function activeCalendar(
  ctx: ToolCtx,
): Promise<{ ref: CalendarRef; name: string } | { error: HandlerOutcome }> {
  const noCalendar: HandlerOutcome = {
    status: 'refused',
    result: fail(
      { slots: [], reason: 'no_calendar' },
      "I can't see the appointment diary right now. I can ask the team to call you back.",
    ),
  };
  if (ctx.deps.calendars === undefined || ctx.deps.secrets === undefined)
    return { error: noCalendar };
  const [row] = await ctx.tx
    .select()
    .from(schema.calendars)
    .where(and(eq(schema.calendars.tenantId, ctx.tenantId), eq(schema.calendars.status, 'active')))
    .orderBy(desc(schema.calendars.updatedAt))
    .limit(1);
  if (row === undefined) return { error: noCalendar };

  let credential: string | null = null;
  if (row.credentialsSecretRef !== null) {
    try {
      credential = await ctx.deps.secrets.resolve(row.credentialsSecretRef);
    } catch {
      return { error: noCalendar };
    }
  }
  return {
    name: row.name,
    ref: {
      id: row.id,
      provider: row.provider,
      externalId: row.externalId,
      timezone: row.timezone,
      slotMinutes: row.slotMinutes,
      config: (row.config ?? {}) as Record<string, unknown>,
      credential,
    },
  };
}

/** The slot ids this call was offered, newest offer first (append-only `agent_actions`). */
async function offeredSlots(
  ctx: ToolCtx,
): Promise<{ id: string; startsAt: string; calendarId: string }[]> {
  const [row] = await ctx.tx
    .select({ result: schema.agentActions.result })
    .from(schema.agentActions)
    .where(
      and(
        eq(schema.agentActions.attemptId, ctx.attempt.id),
        eq(schema.agentActions.tool, 'get_slots'),
        eq(schema.agentActions.status, 'ok'),
      ),
    )
    .orderBy(desc(schema.agentActions.at))
    .limit(1);
  // The row keeps `{ ok, data, say, action }`; the offer list is in `data` (see tools/route.ts).
  const offers = (row?.result as { data?: { offers?: unknown } } | null)?.data?.offers;
  if (!Array.isArray(offers)) return [];
  return offers.filter(
    (o): o is { id: string; startsAt: string; calendarId: string } =>
      o !== null &&
      typeof o === 'object' &&
      typeof (o as { id?: unknown }).id === 'string' &&
      typeof (o as { startsAt?: unknown }).startsAt === 'string' &&
      typeof (o as { calendarId?: unknown }).calendarId === 'string',
  );
}

export async function getSlots(
  ctx: ToolCtx,
  args: { days_ahead?: number | undefined },
): Promise<HandlerOutcome> {
  const found = await activeCalendar(ctx);
  if ('error' in found) return found.error;
  const { ref, name } = found;
  const port = ctx.deps.calendars?.get(ref.provider);
  if (port === undefined)
    return { status: 'refused', result: fail({ slots: [], reason: 'no_calendar' }) };

  const days = args.days_ahead ?? DEFAULT_DAYS_AHEAD;
  let slots;
  try {
    slots = await port.listSlots({
      calendar: ref,
      from: ctx.now,
      to: addDays(ctx.now, days),
      limit: MAX_SLOTS_OFFERED,
    });
  } catch (error) {
    // E-129: down, slow or misconfigured — the agent offers a callback, never a guessed time.
    const transient = error instanceof CalendarUnavailable;
    return {
      status: 'failed',
      result: fail(
        { slots: [], reason: transient ? 'calendar_unavailable' : 'calendar_error' },
        "I can't see the available times right now. I can ask the team to call you back.",
      ),
    };
  }

  if (slots.length === 0)
    return {
      status: 'ok',
      result: ok(
        { slots: [], service: sanitiseMerchantText(name, 60) },
        'I have no free times to offer at the moment. I can ask the team to call you back.',
      ),
    };

  const offers = slots.map((s) => ({
    id: s.id,
    startsAt: s.startsAt.toISOString(),
    calendarId: ref.id,
  }));
  const spoken = slots.map((s) => ({
    slot_id: s.id,
    when: spokenTime(s.startsAt, ref.timezone, 'en-IN'),
  }));
  return {
    status: 'ok',
    result: ok({ service: sanitiseMerchantText(name, 60), timezone: ref.timezone, slots: spoken }),
    // The action row keeps the offer list; `book_slot` checks against it, so what the agent may
    // book is decided by the calendar's answer and not by anything the model repeats back.
    stored: { service: name, calendar_id: ref.id, slots: spoken, offers },
  };
}

export async function bookSlot(
  ctx: ToolCtx,
  args: { slot_id: string; name?: string | undefined },
): Promise<HandlerOutcome> {
  // E-131: we book for the number this call is on, and nobody else.
  if (ctx.attempt.phoneHash === null || ctx.attempt.contactId === null)
    return {
      status: 'refused',
      result: fail(
        { booked: false, reason: 'number_withheld' },
        "Your number is hidden, so I can't hold an appointment against it. I can ask the team to call you back.",
      ),
    };

  const offers = await offeredSlots(ctx);
  const offer = offers.find((o) => o.id === args.slot_id);
  if (offer === undefined)
    // E-132: an id we did not offer on this call, or an offer that was never made.
    return {
      status: 'refused',
      result: fail({ booked: false, reason: 'slot_not_offered' }, 'Let me check the times again.'),
    };

  const found = await activeCalendar(ctx);
  if ('error' in found) return found.error;
  const { ref, name } = found;
  if (ref.id !== offer.calendarId)
    return {
      status: 'refused',
      result: fail({ booked: false, reason: 'slot_not_offered' }, 'Let me check the times again.'),
    };
  const port = ctx.deps.calendars?.get(ref.provider);
  if (port === undefined)
    return { status: 'refused', result: fail({ booked: false, reason: 'no_calendar' }) };

  const [contact] = await ctx.tx
    .select({ name: schema.contacts.name, phoneEnc: schema.contacts.phoneEnc })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.id, ctx.attempt.contactId), isNull(schema.contacts.erasedAt)))
    .limit(1);
  if (contact === undefined)
    return { status: 'refused', result: fail({ booked: false, reason: 'no_contact' }) };

  const startsAt = new Date(offer.startsAt);
  const callerName = sanitiseMerchantText(args.name ?? contact.name ?? 'Naaradh caller', 60);
  let booking;
  try {
    booking = await port.book({
      calendar: ref,
      slotId: offer.id,
      startsAt,
      name: callerName,
      // apps/voice cannot decrypt a customer number (invariant 8): the provider gets none.
      phoneE164: null,
      service: name,
      // Invariant 10: a retried tool call returns the same booking, never a second one.
      idempotencyKey: ctx.actionId,
    });
  } catch (error) {
    if (error instanceof SlotTaken)
      return {
        status: 'refused',
        result: fail(
          { booked: false, reason: 'slot_taken' },
          'I am sorry, that time has just been taken. Let me tell you what is free now.',
        ),
      };
    return {
      status: 'failed',
      result: fail(
        { booked: false, reason: 'calendar_unavailable' },
        "I couldn't complete the booking just now. I can ask the team to call you back.",
      ),
    };
  }

  const appointment = await upsertAppointment(ctx.tx, ctx.deps.keys, {
    tenantId: ctx.tenantId,
    source: 'voice',
    // The action id is unique per tool call, so a replay lands on the same appointment.
    externalId: ctx.actionId,
    calendarId: ref.id,
    rawPhone: null,
    defaultRegion: 'IN',
    customerName: callerName,
    service: name,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    timezone: ref.timezone,
    status: 'confirmed',
    providerRef: booking.providerRef,
    bookedByAttemptId: ctx.attempt.id,
    existingContact: { contactId: ctx.attempt.contactId, phoneHash: ctx.attempt.phoneHash },
    // The customer asked for this appointment out loud on a recorded, disclosed call: that is
    // the consent for the reminder, and the attempt is its evidence (ADR-0011 §7).
    consent: { source: 'verbal', evidenceUri: `naaradh:attempt/${ctx.attempt.id}` },
    now: ctx.now,
  });

  await audit(ctx.tx, {
    tenantId: ctx.tenantId,
    actorType: 'agent',
    actorId: ctx.attempt.id,
    action: 'appointment.booked',
    targetType: 'appointment',
    targetId: appointment.kind === 'recorded' ? appointment.appointmentId : ctx.actionId,
    after: {
      provider: ref.provider,
      provider_ref: booking.providerRef,
      starts_at: booking.startsAt.toISOString(),
      calendar_id: ref.id,
    },
  });

  const when = spokenTime(booking.startsAt, ref.timezone, 'en-IN');
  return {
    status: 'ok',
    result: ok(
      {
        booked: true,
        when,
        service: sanitiseMerchantText(name, 60),
        appointment_id: appointment.kind === 'recorded' ? appointment.appointmentId : null,
      },
      `That's booked: ${when}.`,
    ),
    after: async () => {
      if (appointment.kind !== 'recorded') return;
      await emitMerchantEvent(ctx.tx, ctx.tenantId, {
        type: 'appointment.booked',
        eventId: `${appointment.appointmentId}:booked`,
        at: ctx.now,
        data: {
          appointment_id: appointment.appointmentId,
          calendar_id: ref.id,
          provider_ref: booking.providerRef,
          starts_at: booking.startsAt.toISOString(),
          timezone: ref.timezone,
          service: name,
          attempt_id: ctx.attempt.id,
        },
      });
    },
  };
}
