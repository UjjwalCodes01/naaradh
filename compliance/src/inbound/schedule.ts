import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';

/**
 * P7-INB-1: which inbound profile answers a number right now.
 *
 * A number keeps one default profile (`numbers.inbound_profile_id`); schedule rows only narrow
 * it — "Mon–Fri 09:00–18:00 the day team's profile, every night 21:00–09:00 the after-hours
 * one". When no row matches, or a row cannot be read (an unknown zone), the default answers. A
 * schedule can therefore never leave a number unanswered, and can never pick a profile the
 * tenant does not own (the database refuses that link).
 *
 * An overnight window belongs to the day it STARTS on: Friday 21:00–09:00 still answers at
 * 02:00 on Saturday, and a Monday-only overnight row does not answer at 02:00 on Monday.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const ProfileScheduleInput = z
  .object({
    inbound_profile_id: z.string().regex(/^ipr_[0-9A-HJKMNP-TV-Z]{26}$/),
    zone: z.string().refine((z) => IANAZone.isValidZone(z), 'is not a known IANA time zone'),
    /** ISO weekdays, 1 = Monday … 7 = Sunday. */
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .transform((d) => [...new Set(d)].sort((a, b) => a - b)),
    start_time: z.string().regex(HHMM, 'must be HH:MM'),
    end_time: z.string().regex(HHMM, 'must be HH:MM'),
    priority: z.number().int().min(0).max(1000).default(100),
  })
  .refine((s) => s.start_time !== s.end_time, {
    message: 'start and end must differ (use days to mean all day)',
    path: ['end_time'],
  });

export type ProfileScheduleInput = z.infer<typeof ProfileScheduleInput>;

/** A number carries at most this many rows: a week of distinct shifts, not a timetable. */
export const MAX_SCHEDULES_PER_NUMBER = 20;

export interface ProfileSchedule {
  readonly id: string;
  readonly inboundProfileId: string;
  readonly zone: string;
  readonly days: readonly number[];
  readonly startTime: string;
  readonly endTime: string;
  readonly priority: number;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** Start inclusive, end exclusive, in the schedule's own zone. */
export function scheduleMatches(s: ProfileSchedule, at: Date): boolean {
  if (!IANAZone.isValidZone(s.zone)) return false;
  const local = DateTime.fromJSDate(at, { zone: s.zone });
  if (!local.isValid) return false;
  const now = local.hour * 60 + local.minute;
  const start = minutes(s.startTime);
  const end = minutes(s.endTime);
  if (start < end) return s.days.includes(local.weekday) && now >= start && now < end;
  // Overnight: the evening part is on a listed day, the early-morning part on the day after one.
  if (now >= start) return s.days.includes(local.weekday);
  if (now < end) return s.days.includes(local.weekday === 1 ? 7 : local.weekday - 1);
  return false;
}

/**
 * The profile that answers at `at`: the matching row with the lowest priority (ties broken by
 * id, so the answer never depends on row order), otherwise the number's default.
 */
export function scheduledProfileId(
  schedules: readonly ProfileSchedule[],
  at: Date,
  defaultProfileId: string | null,
): string | null {
  const match = [...schedules]
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .find((s) => scheduleMatches(s, at));
  return match?.inboundProfileId ?? defaultProfileId;
}
