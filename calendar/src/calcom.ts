import { z } from 'zod';
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
 * Cal.com adapter (ADR-0011 §5). HTTP over `fetch`, no SDK.
 *
 * `[VERIFY]` — every path, header and field name below is from Cal.com's published v2 API and
 * has NOT been run against a live account. Before the first production booking: replay a real
 * slots response and a real booking response into the parsers here, and correct them if they
 * differ. The parsers are deliberately strict so a changed shape fails loudly instead of
 * inventing a time (E-129).
 *
 * Per-calendar `config`:
 *   `eventTypeId`     number, the event type slots are read from (falls back to `externalId`)
 *   `attendeeEmail`   the address bookings are made under — providers require an email and
 *                     Naaradh never asks a customer for one (PCD minimisation)
 *   `apiVersion`      the `cal-api-version` date header; default below
 */
const BASE_URL = 'https://api.cal.com/v2';
const API_VERSION = '2024-08-13';
/**
 * Must stay BELOW the agent's tool budget (`TOOL_TIMEOUT_MS.get_slots` is 4 s,
 * `book_slot` 5 s in call-scripts): an adapter that answers after the engine has given up
 * leaves the caller in silence and, worse, can book a slot nobody hears about. Batch callers
 * (the reconcile cancellation sync) raise it explicitly.
 */
const TIMEOUT_MS = 3_000;

const SlotsResponse = z.object({
  data: z.union([
    // `{ data: { "2026-09-20": [{ start: "…" }] } }`
    z.record(z.array(z.object({ start: z.string(), end: z.string().optional() }))),
    // `{ data: { slots: { … } } }`
    z.object({
      slots: z.record(z.array(z.object({ start: z.string(), end: z.string().optional() }))),
    }),
  ]),
});

const BookingResponse = z.object({
  data: z.object({
    uid: z.string().min(1),
    start: z.string(),
    end: z.string().optional(),
    status: z.string().optional(),
  }),
});

export interface CalcomOptions {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

const str = (c: CalendarRef, key: string): string | null => {
  const v = (c.config as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
};

const eventTypeId = (c: CalendarRef): number => {
  const raw = (c.config as { eventTypeId?: unknown }).eventTypeId ?? c.externalId;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new CalendarRejected('calcom', 'no event type id');
  return n;
};

export function calcomCalendar(options: CalcomOptions = {}): CalendarPort {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? BASE_URL;

  async function call(
    calendar: CalendarRef,
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
  ): Promise<unknown> {
    if (calendar.credential === null) throw new CalendarRejected('calcom', 'no API key');
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs ?? TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${calendar.credential}`,
          'cal-api-version': str(calendar, 'apiVersion') ?? API_VERSION,
          'content-type': 'application/json',
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new CalendarUnavailable(
        'calcom',
        error instanceof Error ? error.message : 'network error',
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (response.status === 409) throw new SlotTaken('calcom');
    if (response.status === 429 || response.status >= 500)
      throw new CalendarUnavailable('calcom', `HTTP ${String(response.status)}`);
    if (!response.ok) {
      // A conflict Cal.com reports as a 400 with a message rather than a 409.
      if (/already booked|no longer available|slot.*taken/i.test(text))
        throw new SlotTaken('calcom');
      throw new CalendarRejected(
        'calcom',
        `HTTP ${String(response.status)}: ${text.slice(0, 200)}`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CalendarRejected('calcom', 'response was not JSON');
    }
  }

  const parseSlots = (raw: unknown, calendar: CalendarRef, limit: number): Slot[] => {
    const parsed = SlotsResponse.safeParse(raw);
    if (!parsed.success) throw new CalendarRejected('calcom', 'unexpected slots response');
    const data = parsed.data.data;
    const byDay: Record<string, { start: string; end?: string }[]> =
      'slots' in data && !Array.isArray(data['slots'])
        ? (data as { slots: Record<string, { start: string; end?: string }[]> }).slots
        : (data as Record<string, { start: string; end?: string }[]>);
    const step = calendar.slotMinutes * 60_000;
    const out: Slot[] = [];
    for (const day of Object.keys(byDay).sort())
      for (const s of byDay[day] ?? []) {
        const startsAt = new Date(s.start);
        if (Number.isNaN(startsAt.getTime())) continue;
        out.push({
          id: startsAt.toISOString(),
          startsAt,
          endsAt:
            s.end === undefined || Number.isNaN(Date.parse(s.end))
              ? new Date(startsAt.getTime() + step)
              : new Date(s.end),
        });
      }
    return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).slice(0, limit);
  };

  return {
    provider: 'calcom',

    async listSlots(input: ListSlotsInput): Promise<readonly Slot[]> {
      const q = new URLSearchParams({
        eventTypeId: String(eventTypeId(input.calendar)),
        start: input.from.toISOString(),
        end: input.to.toISOString(),
        timeZone: input.calendar.timezone,
      });
      const raw = await call(input.calendar, `/slots?${q.toString()}`);
      return parseSlots(raw, input.calendar, input.limit ?? 5);
    },

    async book(input: BookInput): Promise<Booking> {
      const email = str(input.calendar, 'attendeeEmail');
      if (email === null)
        throw new CalendarRejected('calcom', 'config.attendeeEmail is required to book');
      const raw = await call(input.calendar, '/bookings', {
        method: 'POST',
        body: {
          eventTypeId: eventTypeId(input.calendar),
          start: input.startsAt.toISOString(),
          attendee: {
            name: input.name,
            email,
            timeZone: input.calendar.timezone,
            language: 'en',
            ...(input.phoneE164 === null || input.phoneE164 === undefined
              ? {}
              : { phoneNumber: input.phoneE164 }),
          },
          metadata: {
            // No customer identifier leaves Naaradh here: the key is our own appointment id.
            naaradh_ref: input.idempotencyKey,
            ...(input.service === null || input.service === undefined
              ? {}
              : { service: input.service }),
          },
        },
      });
      const parsed = BookingResponse.safeParse(raw);
      if (!parsed.success) throw new CalendarRejected('calcom', 'unexpected booking response');
      const b = parsed.data.data;
      return {
        providerRef: b.uid,
        startsAt: new Date(b.start),
        endsAt: b.end === undefined ? null : new Date(b.end),
        status: b.status === 'cancelled' ? 'cancelled' : 'booked',
      };
    },

    async cancel({ calendar, providerRef, reason }): Promise<void> {
      await call(calendar, `/bookings/${encodeURIComponent(providerRef)}/cancel`, {
        method: 'POST',
        body: { cancellationReason: reason ?? 'cancelled on a Naaradh call' },
      });
    },

    async reschedule({ calendar, providerRef, startsAt }): Promise<Booking> {
      const raw = await call(calendar, `/bookings/${encodeURIComponent(providerRef)}/reschedule`, {
        method: 'POST',
        body: {
          start: startsAt.toISOString(),
          reschedulingReason: 'rescheduled on a Naaradh call',
        },
      });
      const parsed = BookingResponse.safeParse(raw);
      if (!parsed.success) throw new CalendarRejected('calcom', 'unexpected reschedule response');
      const b = parsed.data.data;
      return {
        providerRef: b.uid,
        startsAt: new Date(b.start),
        endsAt: b.end === undefined ? null : new Date(b.end),
        status: 'booked',
      };
    },
  };
}
