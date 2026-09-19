import { inZone, isValidZone, parseHm } from '@naaradh/shared';
import { DateTime } from 'luxon';
import {
  WINDOW_IN,
  WINDOW_RULES_CA,
  WINDOW_RULES_EU,
  WINDOW_RULES_FR,
  WINDOW_RULES_US,
  type RegionWindowRules,
  type WindowRule,
} from '../constants.js';
import type { Purpose } from './types.js';
import { isHoliday, type HolidayCalendar } from './holidays.js';

/**
 * Calling windows, evaluated in the RECIPIENT's zone (invariant 2, E-51). All arithmetic is
 * luxon in a named zone; `Date` appears only at the edges.
 *
 * A window is one or more daily segments (France splits the day around lunch), on allowed
 * weekdays, never on the region's public holidays when the rule says so (P6-CMP-1). The hours
 * depend on the purpose: marketing is narrower than a call about the customer's own order.
 *
 * When a recipient's zone is not known precisely (a US number with no shipping address), the
 * window is the INTERSECTION across the country's extreme zones: open only when it is open in
 * the easternmost AND westernmost zone. Conservative by construction — a call that is fine in
 * New York and also fine in Los Angeles is fine everywhere in between. Zones outside that span
 * (Hawaii, Alaska, Atlantic Canada) come from the contact: the shipping address, or the area
 * code at ingestion (`zoneHintForNumber`).
 */

type Hm = { readonly hour: number; readonly minute: number };

export interface RecipientWindow {
  readonly zones: readonly string[];
  readonly segments: readonly { readonly open: Hm; readonly close: Hm }[];
  /** ISO weekdays the window opens on; null = every day. */
  readonly days: readonly number[] | null;
  readonly holidays: HolidayCalendar | null;
  /** How the zone was chosen — recorded in the gate trace. */
  readonly basis: 'india' | 'contact_zone' | 'country_single_zone' | 'country_intersection';
}

interface CountryZones {
  /** The zones whose intersection is used when the recipient's own zone is unknown. */
  readonly extremes: readonly string[];
  /** Every zone a contact hint may name for this country. Anything else is ignored. */
  readonly allowed: readonly string[];
  /** Zone-name prefixes that are also allowed (the US has many county-level zones). */
  readonly allowedPrefixes?: readonly string[];
}

/** `[VERIFY]` for non-IN hours. A hint is trusted only if it is in the country's own list. */
const COUNTRY_ZONES: Readonly<Record<string, CountryZones>> = {
  IN: { extremes: ['Asia/Kolkata'], allowed: ['Asia/Kolkata', 'Asia/Calcutta'] },
  US: {
    extremes: ['America/New_York', 'America/Los_Angeles'],
    allowed: [
      'America/New_York',
      'America/Detroit',
      'America/Chicago',
      'America/Menominee',
      'America/Denver',
      'America/Boise',
      'America/Phoenix',
      'America/Los_Angeles',
      'America/Anchorage',
      'America/Juneau',
      'America/Sitka',
      'America/Yakutat',
      'America/Nome',
      'America/Metlakatla',
      'America/Adak',
      'Pacific/Honolulu',
    ],
    allowedPrefixes: ['America/Indiana/', 'America/Kentucky/', 'America/North_Dakota/'],
  },
  CA: {
    extremes: ['America/Toronto', 'America/Vancouver'],
    allowed: [
      'America/St_Johns',
      'America/Halifax',
      'America/Glace_Bay',
      'America/Moncton',
      'America/Goose_Bay',
      'America/Toronto',
      'America/Winnipeg',
      'America/Regina',
      'America/Swift_Current',
      'America/Edmonton',
      'America/Vancouver',
      'America/Whitehorse',
      'America/Dawson',
      'America/Yellowknife',
      'America/Iqaluit',
      'America/Rankin_Inlet',
    ],
  },
  GB: { extremes: ['Europe/London'], allowed: ['Europe/London'] },
  IE: { extremes: ['Europe/Dublin'], allowed: ['Europe/Dublin'] },
  DE: { extremes: ['Europe/Berlin'], allowed: ['Europe/Berlin', 'Europe/Busingen'] },
  FR: { extremes: ['Europe/Paris'], allowed: ['Europe/Paris'] },
  ES: {
    extremes: ['Europe/Madrid', 'Atlantic/Canary'],
    allowed: ['Europe/Madrid', 'Africa/Ceuta', 'Atlantic/Canary'],
  },
  IT: { extremes: ['Europe/Rome'], allowed: ['Europe/Rome'] },
  NL: { extremes: ['Europe/Amsterdam'], allowed: ['Europe/Amsterdam'] },
  BE: { extremes: ['Europe/Brussels'], allowed: ['Europe/Brussels'] },
  AT: { extremes: ['Europe/Vienna'], allowed: ['Europe/Vienna'] },
  CH: { extremes: ['Europe/Zurich'], allowed: ['Europe/Zurich'] },
  PT: {
    extremes: ['Europe/Lisbon', 'Atlantic/Azores'],
    allowed: ['Europe/Lisbon', 'Atlantic/Madeira', 'Atlantic/Azores'],
  },
  SE: { extremes: ['Europe/Stockholm'], allowed: ['Europe/Stockholm'] },
  DK: { extremes: ['Europe/Copenhagen'], allowed: ['Europe/Copenhagen'] },
  NO: { extremes: ['Europe/Oslo'], allowed: ['Europe/Oslo'] },
  FI: { extremes: ['Europe/Helsinki'], allowed: ['Europe/Helsinki'] },
  PL: { extremes: ['Europe/Warsaw'], allowed: ['Europe/Warsaw'] },
  AU: {
    extremes: ['Australia/Sydney', 'Australia/Perth'],
    allowed: [
      'Australia/Sydney',
      'Australia/Melbourne',
      'Australia/Brisbane',
      'Australia/Adelaide',
      'Australia/Darwin',
      'Australia/Hobart',
      'Australia/Perth',
    ],
  },
  NZ: { extremes: ['Pacific/Auckland'], allowed: ['Pacific/Auckland'] },
  SG: { extremes: ['Asia/Singapore'], allowed: ['Asia/Singapore'] },
  AE: { extremes: ['Asia/Dubai'], allowed: ['Asia/Dubai'] },
};

const EU_LIKE = new Set([
  'GB',
  'IE',
  'DE',
  'ES',
  'IT',
  'NL',
  'BE',
  'AT',
  'CH',
  'PT',
  'SE',
  'DK',
  'NO',
  'FI',
  'PL',
]);

const INDIA_RULE: WindowRule = {
  segments: [{ open: WINDOW_IN.open, close: WINDOW_IN.close }],
  days: null,
  holidays: null,
};

function rulesFor(region: string): RegionWindowRules | null {
  if (region === 'IN')
    return { transactional: INDIA_RULE, service: INDIA_RULE, promotional: INDIA_RULE };
  if (region === 'US') return WINDOW_RULES_US;
  if (region === 'CA') return WINDOW_RULES_CA;
  if (region === 'FR') return WINDOW_RULES_FR;
  if (EU_LIKE.has(region)) return WINDOW_RULES_EU;
  // Anything else we route: the EU rules, the narrowest general set we have. [VERIFY] per country.
  if (COUNTRY_ZONES[region] !== undefined) return WINDOW_RULES_EU;
  return null;
}

/** True when `zone` is a zone of `region` we will take a contact's word for. */
export function zoneBelongsTo(region: string, zone: string): boolean {
  const c = COUNTRY_ZONES[region];
  if (c === undefined || !isValidZone(zone)) return false;
  return c.allowed.includes(zone) || (c.allowedPrefixes ?? []).some((p) => zone.startsWith(p));
}

/**
 * Null when the region is not one we know the hours for — the gate turns that into
 * 'window:unknown_region', never into a guess.
 */
export function windowFor(
  region: string,
  timezoneHint: string | null,
  purpose: Purpose = 'transactional',
): RecipientWindow | null {
  const rules = rulesFor(region);
  const country = COUNTRY_ZONES[region];
  if (rules === null || country === undefined) return null;
  const rule = rules[purpose];
  const shape = {
    segments: rule.segments.map((s) => ({ open: parseHm(s.open), close: parseHm(s.close) })),
    days: rule.days,
    holidays: rule.holidays,
  };

  if (region === 'IN') return { zones: ['Asia/Kolkata'], ...shape, basis: 'india' };
  if (timezoneHint !== null && zoneBelongsTo(region, timezoneHint))
    return { zones: [timezoneHint], ...shape, basis: 'contact_zone' };
  if (country.extremes.length === 1)
    return { zones: country.extremes, ...shape, basis: 'country_single_zone' };
  return { zones: country.extremes, ...shape, basis: 'country_intersection' };
}

function dayAllowed(local: DateTime, w: RecipientWindow): boolean {
  if (w.days !== null && !w.days.includes(local.weekday)) return false;
  if (w.holidays !== null && isHoliday(w.holidays, local)) return false;
  return true;
}

function at(day: DateTime, hm: Hm): DateTime {
  return day.set({ hour: hm.hour, minute: hm.minute, second: 0, millisecond: 0 });
}

/** The segment `local` falls in (close shortened by the buffer), or null. */
function segmentOf(local: DateTime, w: RecipientWindow, bufferMinutes: number) {
  if (!dayAllowed(local, w)) return null;
  for (const s of w.segments) {
    const open = at(local, s.open);
    const close = at(local, s.close);
    if (local >= open && local < close.minus({ minutes: bufferMinutes })) return { open, close };
  }
  return null;
}

/**
 * True when `at` is inside the window in EVERY zone, with `bufferMinutes` shaved off the
 * close so a call that connects does not run past it (E-01: dial by 20:55 for a 21:00 close).
 * Open is inclusive, close is exclusive: 09:00:00 is open, 21:00:00 is closed.
 */
export function isOpen(instant: Date, w: RecipientWindow, bufferMinutes = 0): boolean {
  return w.zones.every((zone) => segmentOf(inZone(instant, zone), w, bufferMinutes) !== null);
}

/**
 * The instant the current segment closes, taken as the EARLIEST close across zones. Returns
 * null when the window is not open now.
 */
export function closesAt(instant: Date, w: RecipientWindow): Date | null {
  let earliest: DateTime | null = null;
  for (const zone of w.zones) {
    const seg = segmentOf(inZone(instant, zone), w, 0);
    if (seg === null) return null;
    if (earliest === null || seg.close < earliest) earliest = seg.close;
  }
  return earliest === null ? null : earliest.toJSDate();
}

/**
 * The earliest instant strictly after `after` at which the window is open in every zone.
 * Bounded search — windows recur weekly at most, so it always terminates quickly.
 */
export function nextOpen(after: Date, w: RecipientWindow, bufferMinutes = 0): Date {
  // Fixed-point iteration. For each zone, the earliest instant ≥ candidate at which THAT
  // zone is open; the latest of those is the first instant every zone could be open;
  // re-evaluate there until all zones agree.
  let candidate: DateTime = DateTime.fromJSDate(after, { zone: 'utc' });
  for (let i = 0; i < 64; i += 1) {
    let latest: DateTime = candidate;
    for (const zone of w.zones) {
      const zoneReady = zoneNextOpen(candidate, zone, w, bufferMinutes);
      if (zoneReady > latest) latest = zoneReady;
    }
    if (isOpen(latest.toJSDate(), w, bufferMinutes)) return latest.toJSDate();
    // Every zone was individually ready at `latest` yet the intersection is closed — one
    // zone's opening falls inside another's close. Step a minute past it.
    candidate = latest.equals(candidate) ? latest.plus({ minutes: 1 }) : latest;
  }
  throw new Error(`nextOpen: no opening found for zones ${w.zones.join(',')}`);
}

function zoneNextOpen(
  candidate: DateTime,
  zone: string,
  w: RecipientWindow,
  bufferMinutes: number,
): DateTime {
  const local = candidate.setZone(zone);
  if (segmentOf(local, w, bufferMinutes) !== null) return candidate;
  // Three weeks covers the longest run of closed days any rule produces (a weekend plus
  // holidays), with room to spare.
  for (let d = 0; d < 21; d += 1) {
    const day = local.startOf('day').plus({ days: d });
    if (!dayAllowed(day, w)) continue;
    for (const s of w.segments) {
      const open = at(day, s.open);
      if (open > local) return open;
    }
  }
  throw new Error(`nextOpen: window never opens in ${zone}`);
}
