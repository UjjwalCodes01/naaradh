import { calcomCalendar } from './calcom.js';
import { fakeCalendar } from './fake.js';
import { CalendarRejected, type CalendarPort, type CalendarProvider } from './types.js';

/**
 * One port per provider, chosen by `calendars.provider`. `manual` is a merchant with no
 * connected calendar: Naaradh holds the slots itself (the fake's grid), which is also what
 * `pnpm dev` uses. Google Calendar needs per-merchant OAuth and is not here yet (ADR-0011 §5).
 */
export interface CalendarRegistry {
  get(provider: CalendarProvider): CalendarPort;
}

export function calendarRegistry(
  options: { readonly now?: () => Date; readonly fetchImpl?: typeof fetch } = {},
): CalendarRegistry {
  const now = options.now ?? (() => new Date());
  const ports: Partial<Record<CalendarProvider, CalendarPort>> = {
    calcom: calcomCalendar(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    manual: fakeCalendar({ now }),
  };
  return {
    get(provider) {
      const port = ports[provider];
      if (port === undefined)
        throw new CalendarRejected(provider, 'no adapter for this calendar provider yet');
      return port;
    },
  };
}
