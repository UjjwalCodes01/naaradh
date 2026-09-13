import { inZone, isValidZone, parseHm } from '@naaradh/shared';
import { DateTime } from 'luxon';
import { WINDOW_EU_DEFAULT, WINDOW_IN, WINDOW_US_DEFAULT } from '../constants.js';

/**
 * Calling windows, evaluated in the RECIPIENT's zone (invariant 2, E-51). All arithmetic is
 * luxon in a named zone; `Date` appears only at the edges.
 *
 * When a recipient's zone is not known precisely (a US number with no shipping address), the
 * window is the INTERSECTION across the country's zones: open only when it is open in the
 * easternmost AND westernmost zone. Conservative by construction — a call that is fine in
 * New York and also fine in Los Angeles is fine everywhere in between.
 */

export interface RecipientWindow {
  readonly zones: readonly string[];
  readonly open: { hour: number; minute: number };
  readonly close: { hour: number; minute: number };
  /** How the zone was chosen — recorded in the gate trace. */
  readonly basis: 'india' | 'contact_zone' | 'country_single_zone' | 'country_intersection';
}

/** Region → zones. Multi-zone countries list their extreme zones. `[VERIFY]` for non-IN hours. */
const REGION_ZONES: Readonly<Record<string, readonly string[]>> = {
  IN: ['Asia/Kolkata'],
  US: ['America/New_York', 'America/Los_Angeles'],
  CA: ['America/Toronto', 'America/Vancouver'],
  GB: ['Europe/London'],
  IE: ['Europe/Dublin'],
  DE: ['Europe/Berlin'],
  FR: ['Europe/Paris'],
  ES: ['Europe/Madrid'],
  IT: ['Europe/Rome'],
  NL: ['Europe/Amsterdam'],
  BE: ['Europe/Brussels'],
  AT: ['Europe/Vienna'],
  CH: ['Europe/Zurich'],
  PT: ['Europe/Lisbon'],
  SE: ['Europe/Stockholm'],
  DK: ['Europe/Copenhagen'],
  NO: ['Europe/Oslo'],
  FI: ['Europe/Helsinki'],
  PL: ['Europe/Warsaw'],
  AU: ['Australia/Sydney', 'Australia/Perth'],
  NZ: ['Pacific/Auckland'],
  SG: ['Asia/Singapore'],
  AE: ['Asia/Dubai'],
};

const EU_LIKE = new Set([
  'GB',
  'IE',
  'DE',
  'FR',
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
const US_LIKE = new Set(['US', 'CA']);

function hoursFor(region: string): { open: string; close: string } | null {
  if (region === 'IN') return { open: WINDOW_IN.open, close: WINDOW_IN.close };
  if (US_LIKE.has(region)) return { open: WINDOW_US_DEFAULT.open, close: WINDOW_US_DEFAULT.close };
  if (EU_LIKE.has(region)) return { open: WINDOW_EU_DEFAULT.open, close: WINDOW_EU_DEFAULT.close };
  // Conservative default for anything else we route: the EU hours. [VERIFY] per country.
  if (REGION_ZONES[region] !== undefined)
    return { open: WINDOW_EU_DEFAULT.open, close: WINDOW_EU_DEFAULT.close };
  return null;
}

/**
 * Null when the region is not one we know the hours for — the gate turns that into
 * 'window:unknown_region', never into a guess.
 */
export function windowFor(region: string, timezoneHint: string | null): RecipientWindow | null {
  const hours = hoursFor(region);
  if (hours === null) return null;
  const open = parseHm(hours.open);
  const close = parseHm(hours.close);

  if (region === 'IN') return { zones: ['Asia/Kolkata'], open, close, basis: 'india' };

  const countryZones = REGION_ZONES[region] ?? [];
  if (
    timezoneHint !== null &&
    isValidZone(timezoneHint) &&
    zoneBelongsTo(timezoneHint, countryZones)
  ) {
    return { zones: [timezoneHint], open, close, basis: 'contact_zone' };
  }
  if (countryZones.length === 1)
    return { zones: countryZones, open, close, basis: 'country_single_zone' };
  return { zones: countryZones, open, close, basis: 'country_intersection' };
}

/** A hint is only trusted if it is plausibly in the recipient's country (same continent prefix). */
function zoneBelongsTo(zone: string, countryZones: readonly string[]): boolean {
  const continent = zone.split('/')[0];
  return countryZones.some((z) => z.split('/')[0] === continent);
}

function localOpenClose(day: DateTime, w: RecipientWindow): { open: DateTime; close: DateTime } {
  return {
    open: day.set({ hour: w.open.hour, minute: w.open.minute, second: 0, millisecond: 0 }),
    close: day.set({ hour: w.close.hour, minute: w.close.minute, second: 0, millisecond: 0 }),
  };
}

/**
 * True when `at` is inside the window in EVERY zone, with `bufferMinutes` shaved off the
 * close so a call that connects does not run past it (E-01: dial by 20:55 for a 21:00 close).
 * Open is inclusive, close is exclusive: 09:00:00 is open, 21:00:00 is closed.
 */
export function isOpen(at: Date, w: RecipientWindow, bufferMinutes = 0): boolean {
  return w.zones.every((zone) => {
    const local = inZone(at, zone);
    const { open, close } = localOpenClose(local, w);
    const effectiveClose = close.minus({ minutes: bufferMinutes });
    return local >= open && local < effectiveClose;
  });
}

/**
 * The instant the window closes for the current local day, taken as the EARLIEST close
 * across zones. Returns null when the window is not open now.
 */
export function closesAt(at: Date, w: RecipientWindow): Date | null {
  if (!isOpen(at, w)) return null;
  let earliest: DateTime | null = null;
  for (const zone of w.zones) {
    const { close } = localOpenClose(inZone(at, zone), w);
    if (earliest === null || close < earliest) earliest = close;
  }
  return earliest === null ? null : earliest.toJSDate();
}

/**
 * The earliest instant strictly after `after` at which the window is open in every zone.
 * Bounded search (a few days) — windows recur daily, so it always terminates quickly.
 */
export function nextOpen(after: Date, w: RecipientWindow, bufferMinutes = 0): Date {
  // Fixed-point iteration. For each zone, the earliest instant ≥ candidate at which THAT
  // zone is open: the candidate itself if the zone is open now, else today's opening, else
  // tomorrow's. The latest of those is the first instant every zone could be open;
  // re-evaluate there until all zones agree. Windows recur daily, so this converges in a
  // handful of rounds — the bound is a guard, not a budget.
  let candidate: DateTime = DateTime.fromJSDate(after, { zone: 'utc' });
  for (let i = 0; i < 16; i += 1) {
    let latest: DateTime = candidate;
    for (const zone of w.zones) {
      const zoneReady = zoneNextOpen(candidate, zone, w, bufferMinutes);
      if (zoneReady > latest) latest = zoneReady;
    }
    if (isOpen(latest.toJSDate(), w, bufferMinutes)) return latest.toJSDate();
    // Every zone was individually ready at `latest` yet the intersection is closed — only
    // possible when one zone's opening falls inside another's close buffer. Step a minute.
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
  const { open, close } = localOpenClose(local, w);
  const effectiveClose = close.minus({ minutes: bufferMinutes });
  if (local >= open && local < effectiveClose) return candidate;
  if (local < open) return open;
  return open.plus({ days: 1 });
}
