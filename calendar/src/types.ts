import { NaaradhError } from '@naaradh/shared';

/**
 * The calendar port (ADR-0011 §5). Product code — the agent tools, the workers, the dashboard —
 * only ever sees this. A provider's SDK, URL shapes and quirks stay inside its adapter, the way
 * voice vendors stay inside `engines/<vendor>` (invariant 13).
 *
 * Two rules the port exists to enforce:
 *   1. A slot the agent may offer comes from `listSlots` and nowhere else (E-129, E-132).
 *   2. Only the provider decides that a booking happened. `book()` either returns the
 *      provider's booking or throws; there is no optimistic "probably booked" (E-130).
 */

export const CALENDAR_PROVIDERS = ['calcom', 'google', 'manual'] as const;
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];

/** Everything an adapter needs about one calendar. The credential is resolved by the caller. */
export interface CalendarRef {
  readonly id: string;
  readonly provider: CalendarProvider;
  /** Provider's event type / calendar id. */
  readonly externalId: string;
  /** IANA zone the merchant's day is in. */
  readonly timezone: string;
  readonly slotMinutes: number;
  /** Provider quirks from `calendars.config` (event type slug, attendee email). */
  readonly config: Readonly<Record<string, unknown>>;
  /** The resolved API credential, or null when the provider needs none (`manual`). */
  readonly credential: string | null;
}

export interface Slot {
  /**
   * Opaque, provider-scoped id the agent quotes back to `book()`. Adapters that have no slot id
   * of their own use the ISO start time, which is what `manual` and Cal.com do.
   */
  readonly id: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface ListSlotsInput {
  readonly calendar: CalendarRef;
  readonly from: Date;
  readonly to: Date;
  /** How many to return at most; the agent should never read out more than a handful. */
  readonly limit?: number;
}

export interface BookInput {
  readonly calendar: CalendarRef;
  readonly slotId: string;
  readonly startsAt: Date;
  /** The customer's first name, as it will appear in the merchant's calendar. */
  readonly name: string;
  /** E.164, when the flow has it. Never logged by an adapter. */
  readonly phoneE164?: string | null;
  /** What the appointment is for — a service name, never a reason for the visit. */
  readonly service?: string | null;
  /** Same key → same booking, so a retried tool call cannot double-book (invariant 10). */
  readonly idempotencyKey: string;
}

export interface Booking {
  readonly providerRef: string;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  /** What the provider says the booking is now. */
  readonly status: 'booked' | 'cancelled';
}

export interface CalendarPort {
  readonly provider: CalendarProvider;
  listSlots(input: ListSlotsInput): Promise<readonly Slot[]>;
  book(input: BookInput): Promise<Booking>;
  cancel(input: {
    readonly calendar: CalendarRef;
    readonly providerRef: string;
    readonly reason?: string;
  }): Promise<void>;
  reschedule(input: {
    readonly calendar: CalendarRef;
    readonly providerRef: string;
    readonly slotId: string;
    readonly startsAt: Date;
  }): Promise<Booking>;
}

/** The provider is down, slow or rate-limiting: retry later, offer a callback now (E-129). */
export class CalendarUnavailable extends NaaradhError {
  constructor(provider: string, detail: string) {
    super('ENGINE_UNAVAILABLE', `calendar ${provider} unavailable: ${detail}`, {
      context: { provider },
    });
  }
}

/** Someone else took the slot between the offer and the booking (E-130). */
export class SlotTaken extends NaaradhError {
  constructor(provider: string) {
    super('CONFLICT', 'that time has just been taken', { context: { provider } });
  }
}

/** The provider refused for a reason retrying will not fix (bad event type, no credential). */
export class CalendarRejected extends NaaradhError {
  constructor(provider: string, detail: string) {
    super('VALIDATION_FAILED', `calendar ${provider} refused: ${detail}`, {
      context: { provider },
    });
  }
}
