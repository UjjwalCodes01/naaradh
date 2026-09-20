import {
  CalendarRejected,
  CalendarUnavailable,
  SlotTaken,
  type Booking,
  type BookInput,
  type CalendarPort,
  type CalendarRef,
  type ListSlotsInput,
  type Slot,
} from './types.js';

/**
 * A calendar that behaves, on purpose, like a real one having a bad day: slots on a fixed grid,
 * a slot that is already taken, a provider that is down, and bookings that are idempotent on
 * the key. Used by the tool tests and the appointment integration test, and by `pnpm dev` when
 * no provider is configured.
 *
 * Scenarios are chosen by the calendar's `config`:
 *   `{ fake: 'down' }`     → every call throws CalendarUnavailable (E-129)
 *   `{ fake: 'full' }`     → listSlots returns nothing
 *   `{ takenSlotIds: [] }` → those slot ids throw SlotTaken (E-130)
 */
export function fakeCalendar(options: { readonly now: () => Date } = { now: () => new Date() }) {
  const bookings = new Map<string, Booking>();
  const byRef = new Map<string, { booking: Booking; calendarId: string }>();
  let nextRef = 1;

  const mode = (c: CalendarRef): string => {
    const v = (c.config as { fake?: unknown }).fake;
    return typeof v === 'string' ? v : 'ok';
  };
  const taken = (c: CalendarRef): readonly string[] => {
    const v = (c.config as { takenSlotIds?: unknown }).takenSlotIds;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  };
  const guard = (c: CalendarRef) => {
    if (mode(c) === 'down') throw new CalendarUnavailable('fake', 'simulated outage');
    if (c.provider !== 'manual' && c.credential === null)
      throw new CalendarRejected('fake', 'no credential configured');
  };

  const port: CalendarPort & { readonly bookings: ReadonlyMap<string, Booking> } = {
    provider: 'manual',
    bookings,

    async listSlots(input: ListSlotsInput): Promise<readonly Slot[]> {
      guard(input.calendar);
      if (mode(input.calendar) === 'full') return [];
      const step = input.calendar.slotMinutes * 60_000;
      const out: Slot[] = [];
      // Align to the next slot boundary after `from`, never in the past.
      const start = Math.max(input.from.getTime(), options.now().getTime());
      let t = Math.ceil(start / step) * step;
      while (t < input.to.getTime() && out.length < (input.limit ?? 5)) {
        const startsAt = new Date(t);
        const id = startsAt.toISOString();
        if (!byRef.has(id) && !taken(input.calendar).includes(id))
          out.push({ id, startsAt, endsAt: new Date(t + step) });
        t += step;
      }
      return out;
    },

    async book(input: BookInput): Promise<Booking> {
      guard(input.calendar);
      const existing = bookings.get(input.idempotencyKey);
      if (existing !== undefined) return existing;
      if (taken(input.calendar).includes(input.slotId)) throw new SlotTaken('fake');
      const held = byRef.get(input.slotId);
      if (held !== undefined && held.booking.status === 'booked') throw new SlotTaken('fake');
      const booking: Booking = {
        providerRef: `fake-booking-${String(nextRef)}`,
        startsAt: input.startsAt,
        endsAt: new Date(input.startsAt.getTime() + input.calendar.slotMinutes * 60_000),
        status: 'booked',
      };
      nextRef += 1;
      bookings.set(input.idempotencyKey, booking);
      byRef.set(input.slotId, { booking, calendarId: input.calendar.id });
      byRef.set(booking.providerRef, { booking, calendarId: input.calendar.id });
      return booking;
    },

    async cancel({ calendar, providerRef }): Promise<void> {
      guard(calendar);
      const held = byRef.get(providerRef);
      if (held === undefined) throw new CalendarRejected('fake', 'unknown booking');
      byRef.set(providerRef, { ...held, booking: { ...held.booking, status: 'cancelled' } });
    },

    async reschedule({ calendar, providerRef, slotId, startsAt }): Promise<Booking> {
      guard(calendar);
      const held = byRef.get(providerRef);
      if (held === undefined) throw new CalendarRejected('fake', 'unknown booking');
      if (taken(calendar).includes(slotId)) throw new SlotTaken('fake');
      const booking: Booking = {
        ...held.booking,
        startsAt,
        endsAt: new Date(startsAt.getTime() + calendar.slotMinutes * 60_000),
      };
      byRef.set(providerRef, { ...held, booking });
      byRef.set(slotId, { booking, calendarId: calendar.id });
      return booking;
    },
  };
  return port;
}
