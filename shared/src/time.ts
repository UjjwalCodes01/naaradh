import { DateTime, IANAZone } from 'luxon';

/**
 * Small, explicit time helpers. The compliance package does all window arithmetic with
 * luxon in the recipient's zone (CLAUDE.md); this file only makes that ergonomic and keeps
 * `Date` at the edges.
 */

/** Injectable clock — every gate, retry and window decision takes one of these. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(at: Date | string): Clock {
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) throw new TypeError(`fixedClock: bad instant ${String(at)}`);
  return { now: () => new Date(d.getTime()) };
}

export function isValidZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

export function inZone(at: Date, zone: string): DateTime {
  const dt = DateTime.fromJSDate(at, { zone });
  if (!dt.isValid) throw new TypeError(`inZone: ${dt.invalidExplanation ?? 'invalid'}`);
  return dt;
}

export function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 86_400_000);
}

/** "09:00" → { hour: 9, minute: 0 }. Throws on anything else. */
export function parseHm(hm: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hm);
  if (m === null) throw new TypeError(`parseHm: expected HH:MM, got ${hm}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function isoUtc(at: Date): string {
  return at.toISOString();
}

export function unixSeconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}
