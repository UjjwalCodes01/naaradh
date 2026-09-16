import { describe, expect, it, vi } from 'vitest';
import {
  CalendarRejected,
  CalendarUnavailable,
  SlotTaken,
  calcomCalendar,
  calendarRegistry,
  fakeCalendar,
  type CalendarRef,
} from '../src/index.js';

/**
 * The calendar port (ADR-0011 §5–6). What matters here is not that a happy booking works, but
 * that a provider's bad day can never become an invented appointment time.
 */

const NOW = new Date('2026-09-21T04:30:00Z'); // Monday 10:00 IST
const now = () => NOW;

const ref = (config: Record<string, unknown> = {}): CalendarRef => ({
  id: 'cal_01SEEDCALENDAR00000000000A',
  provider: 'manual',
  externalId: '123456',
  timezone: 'Asia/Kolkata',
  slotMinutes: 30,
  config,
  credential: null,
});

describe('the fake calendar (what tests and `pnpm dev` use)', () => {
  it('offers slots on the grid, never in the past, and at most the limit asked for', async () => {
    const port = fakeCalendar({ now });
    const slots = await port.listSlots({
      calendar: ref(),
      from: new Date(NOW.getTime() - 3 * 3_600_000),
      to: new Date(NOW.getTime() + 3 * 3_600_000),
      limit: 3,
    });
    expect(slots).toHaveLength(3);
    for (const s of slots) {
      expect(s.startsAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
      expect(s.startsAt.getTime() % (30 * 60_000)).toBe(0);
      expect(s.endsAt.getTime() - s.startsAt.getTime()).toBe(30 * 60_000);
      expect(s.id).toBe(s.startsAt.toISOString());
    }
  });

  it('a booking is idempotent on the key — a retried tool call never books twice', async () => {
    const port = fakeCalendar({ now });
    const [slot] = await port.listSlots({
      calendar: ref(),
      from: NOW,
      to: new Date(NOW.getTime() + 86_400_000),
    });
    const book = () =>
      port.book({
        calendar: ref(),
        slotId: slot?.id ?? '',
        startsAt: slot?.startsAt ?? NOW,
        name: 'Asha',
        idempotencyKey: 'act_01SEEDACTION000000000000A',
      });
    const first = await book();
    const second = await book();
    expect(second.providerRef).toBe(first.providerRef);
  });

  it('E-130: a slot taken since the offer is refused, not silently moved', async () => {
    const port = fakeCalendar({ now });
    const taken = new Date(NOW.getTime() + 30 * 60_000).toISOString();
    await expect(
      port.book({
        calendar: ref({ takenSlotIds: [taken] }),
        slotId: taken,
        startsAt: new Date(taken),
        name: 'Asha',
        idempotencyKey: 'act_01SEEDACTION000000000000B',
      }),
    ).rejects.toThrow(SlotTaken);
    // …and the taken slot is not offered again.
    const slots = await port.listSlots({
      calendar: ref({ takenSlotIds: [taken] }),
      from: NOW,
      to: new Date(NOW.getTime() + 2 * 3_600_000),
    });
    expect(slots.map((s) => s.id)).not.toContain(taken);
  });

  it('E-129: a provider having an outage offers nothing at all', async () => {
    const port = fakeCalendar({ now });
    await expect(
      port.listSlots({ calendar: ref({ fake: 'down' }), from: NOW, to: NOW }),
    ).rejects.toThrow(CalendarUnavailable);
    expect(await port.listSlots({ calendar: ref({ fake: 'full' }), from: NOW, to: NOW })).toEqual(
      [],
    );
  });

  it('a hosted provider without a credential is a configuration error, not an outage', async () => {
    const port = fakeCalendar({ now });
    await expect(
      port.listSlots({ calendar: { ...ref(), provider: 'calcom' }, from: NOW, to: NOW }),
    ).rejects.toThrow(CalendarRejected);
  });

  it('cancel and reschedule work through the provider reference', async () => {
    const port = fakeCalendar({ now });
    const [slot, next] = await port.listSlots({
      calendar: ref(),
      from: NOW,
      to: new Date(NOW.getTime() + 86_400_000),
    });
    const booking = await port.book({
      calendar: ref(),
      slotId: slot?.id ?? '',
      startsAt: slot?.startsAt ?? NOW,
      name: 'Asha',
      idempotencyKey: 'act_01SEEDACTION000000000000C',
    });
    const moved = await port.reschedule({
      calendar: ref(),
      providerRef: booking.providerRef,
      slotId: next?.id ?? '',
      startsAt: next?.startsAt ?? NOW,
    });
    expect(moved.startsAt).toEqual(next?.startsAt);
    await expect(
      port.cancel({ calendar: ref(), providerRef: booking.providerRef }),
    ).resolves.toBeUndefined();
    await expect(port.cancel({ calendar: ref(), providerRef: 'nope' })).rejects.toThrow(
      CalendarRejected,
    );
  });
});

describe('the Cal.com adapter (shapes are [VERIFY] until run against a live account)', () => {
  const calcomRef: CalendarRef = {
    ...ref({ eventTypeId: 42, attendeeEmail: 'appointments@merchant.example' }),
    provider: 'calcom',
    credential: 'cal_live_key',
  };
  const response = (status: number, body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  it('sends the key and the API version, and reads both slot response shapes', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer cal_live_key');
      expect(headers['cal-api-version']).toBeTruthy();
      return response(200, {
        data: { '2026-09-22': [{ start: '2026-09-22T05:00:00.000Z' }] },
      });
    }) as unknown as typeof fetch;
    const port = calcomCalendar({ fetchImpl });
    const slots = await port.listSlots({ calendar: calcomRef, from: NOW, to: NOW, limit: 5 });
    expect(slots).toEqual([
      {
        id: '2026-09-22T05:00:00.000Z',
        startsAt: new Date('2026-09-22T05:00:00.000Z'),
        endsAt: new Date('2026-09-22T05:30:00.000Z'),
      },
    ]);

    const nested = vi.fn(async () =>
      response(200, { data: { slots: { '2026-09-22': [{ start: '2026-09-22T06:00:00.000Z' }] } } }),
    ) as unknown as typeof fetch;
    const slots2 = await calcomCalendar({ fetchImpl: nested }).listSlots({
      calendar: calcomRef,
      from: NOW,
      to: NOW,
    });
    expect(slots2[0]?.startsAt).toEqual(new Date('2026-09-22T06:00:00.000Z'));
  });

  it('a changed response shape fails loudly instead of inventing a time', async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, { slots: ['2026-09-22T05:00:00Z'] }),
    ) as unknown as typeof fetch;
    await expect(
      calcomCalendar({ fetchImpl }).listSlots({ calendar: calcomRef, from: NOW, to: NOW }),
    ).rejects.toThrow(CalendarRejected);
  });

  it('classifies statuses: 429/5xx transient, 409 and "already booked" as taken, 4xx refused', async () => {
    const statuses: [number, unknown, unknown][] = [
      [429, 'slow down', CalendarUnavailable],
      [503, 'nope', CalendarUnavailable],
      [409, '', SlotTaken],
      [400, 'that slot is already booked', SlotTaken],
      [400, 'unknown event type', CalendarRejected],
    ];
    for (const [status, body, error] of statuses) {
      const fetchImpl = vi.fn(async () => response(status, body)) as unknown as typeof fetch;
      await expect(
        calcomCalendar({ fetchImpl }).listSlots({ calendar: calcomRef, from: NOW, to: NOW }),
      ).rejects.toThrow(error as never);
    }
  });

  it('a network failure or timeout is an outage, never a booking', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(
      calcomCalendar({ fetchImpl }).listSlots({ calendar: calcomRef, from: NOW, to: NOW }),
    ).rejects.toThrow(CalendarUnavailable);
  });

  it('books with the attendee email from config, and refuses without one', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '{}';
      sent = JSON.parse(body) as Record<string, unknown>;
      return response(200, { data: { uid: 'bk_1', start: '2026-09-22T05:00:00.000Z' } });
    }) as unknown as typeof fetch;
    const booking = await calcomCalendar({ fetchImpl }).book({
      calendar: calcomRef,
      slotId: '2026-09-22T05:00:00.000Z',
      startsAt: new Date('2026-09-22T05:00:00.000Z'),
      name: 'Asha',
      service: 'Blood test',
      idempotencyKey: 'act_01SEEDACTION000000000000D',
    });
    expect(booking.providerRef).toBe('bk_1');
    expect(sent['eventTypeId']).toBe(42);
    expect((sent['attendee'] as { email?: string }).email).toBe('appointments@merchant.example');
    // Our own reference travels as metadata; no customer identifier does.
    expect((sent['metadata'] as { naaradh_ref?: string }).naaradh_ref).toBe(
      'act_01SEEDACTION000000000000D',
    );
    expect(JSON.stringify(sent)).not.toContain('+91');

    await expect(
      calcomCalendar({ fetchImpl }).book({
        calendar: { ...calcomRef, config: { eventTypeId: 42 } },
        slotId: 'x',
        startsAt: NOW,
        name: 'Asha',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow(/attendeeEmail/);
  });
});

describe('the registry', () => {
  it('serves calcom and manual, and refuses a provider with no adapter yet', () => {
    const registry = calendarRegistry({ now });
    expect(registry.get('calcom').provider).toBe('calcom');
    expect(registry.get('manual').provider).toBe('manual');
    expect(() => registry.get('google')).toThrow(/no adapter/);
  });
});
