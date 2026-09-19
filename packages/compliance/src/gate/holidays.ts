import type { DateTime } from 'luxon';

/**
 * Public holidays on which marketing calls do not start (P6-CMP-1). Computed, never listed by
 * year, so there is no table to fall out of date. `day` is a luxon DateTime already in the
 * recipient's zone; only its calendar date matters.
 *
 * Both calendars err wide: a date that is a holiday in any common reading is treated as one.
 */

export type HolidayCalendar = 'US' | 'FR';

export function isHoliday(calendar: HolidayCalendar, day: DateTime): boolean {
  return calendar === 'US' ? isUsFederalHoliday(day) : isFrenchPublicHoliday(day);
}

const key = (month: number, date: number): string => `${String(month)}-${String(date)}`;

/** The n-th `weekday` (1 = Monday … 7 = Sunday) of a month; n = -1 is the last. */
function nthWeekday(year: number, month: number, weekday: number, n: number, day: DateTime) {
  const first = day.set({ year, month, day: 1 });
  if (n > 0) {
    const offset = (weekday - first.weekday + 7) % 7;
    return first.plus({ days: offset + (n - 1) * 7 });
  }
  const last = first.endOf('month').startOf('day');
  const back = (last.weekday - weekday + 7) % 7;
  return last.minus({ days: back });
}

/**
 * US federal holidays (5 U.S.C. 6103) and their observed dates: a holiday on a Saturday is
 * observed the Friday before, on a Sunday the Monday after. Both the actual and the observed
 * date count — several state solicitation laws say "legal holiday" without saying which.
 */
export function isUsFederalHoliday(day: DateTime): boolean {
  const y = day.year;
  const fixed: readonly [number, number][] = [
    [1, 1], // New Year's Day
    [6, 19], // Juneteenth
    [7, 4], // Independence Day
    [11, 11], // Veterans Day
    [12, 25], // Christmas Day
  ];
  const dates = new Set<string>();
  for (const yr of [y - 1, y, y + 1]) {
    for (const [m, d] of fixed) {
      const actual = day.set({ year: yr, month: m, day: d });
      dates.add(`${String(actual.year)}-${key(actual.month, actual.day)}`);
      const observed =
        actual.weekday === 6
          ? actual.minus({ days: 1 })
          : actual.weekday === 7
            ? actual.plus({ days: 1 })
            : null;
      if (observed !== null)
        dates.add(`${String(observed.year)}-${key(observed.month, observed.day)}`);
    }
  }
  const floating = [
    nthWeekday(y, 1, 1, 3, day), // Martin Luther King Jr. Day
    nthWeekday(y, 2, 1, 3, day), // Washington's Birthday
    nthWeekday(y, 5, 1, -1, day), // Memorial Day
    nthWeekday(y, 9, 1, 1, day), // Labor Day
    nthWeekday(y, 10, 1, 2, day), // Columbus Day
    nthWeekday(y, 11, 4, 4, day), // Thanksgiving Day
  ];
  for (const f of floating) dates.add(`${String(f.year)}-${key(f.month, f.day)}`);
  return dates.has(`${String(y)}-${key(day.month, day.day)}`);
}

/** Western Easter Sunday (anonymous Gregorian algorithm). */
function easter(year: number, day: DateTime): DateTime {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const date = ((h + l - 7 * m + 114) % 31) + 1;
  return day.set({ year, month, day: date });
}

/**
 * French public holidays (Code du travail L3133-1), plus Good Friday and 26 December, which are
 * holidays in Alsace-Moselle — a number does not say which département it is in.
 */
export function isFrenchPublicHoliday(day: DateTime): boolean {
  const fixed = new Set([
    key(1, 1),
    key(5, 1),
    key(5, 8),
    key(7, 14),
    key(8, 15),
    key(11, 1),
    key(11, 11),
    key(12, 25),
    key(12, 26),
  ]);
  if (fixed.has(key(day.month, day.day))) return true;
  const sunday = easter(day.year, day);
  const movable = [-2, 1, 39, 50].map((offset) => sunday.plus({ days: offset }));
  return movable.some((m) => m.month === day.month && m.day === day.day);
}
