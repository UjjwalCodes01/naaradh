import { describe, expect, it } from 'vitest';
import {
  ProfileScheduleInput,
  scheduleMatches,
  scheduledProfileId,
  type ProfileSchedule,
} from '../../src/index.js';

/**
 * P7-INB-1: one number, a different inbound profile by time of day. A schedule narrows the
 * number's default; it can never leave a number unanswered.
 */

const DAY = 'ipr_01DAYTEAM00000000000000000';
const NIGHT = 'ipr_01N1GHT0000000000000000000';
const DEFAULT = 'ipr_01DEFA00000000000000000000';

const row = (over: Partial<ProfileSchedule>): ProfileSchedule => ({
  id: 'nps_01AAAAAAAAAAAAAAAAAAAAAAAA',
  inboundProfileId: DAY,
  zone: 'Asia/Kolkata',
  days: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '18:00',
  priority: 100,
  ...over,
});

// 2026-09-28 is a Monday. IST is UTC+05:30.
const ist = (isoLocal: string) => new Date(`${isoLocal}+05:30`);

describe('a daytime window', () => {
  const s = row({});
  it('answers inside the hours, start inclusive', () => {
    expect(scheduleMatches(s, ist('2026-09-28T09:00:00'))).toBe(true);
    expect(scheduleMatches(s, ist('2026-09-28T17:59:00'))).toBe(true);
  });
  it('does not answer at the end minute (end exclusive) or before opening', () => {
    expect(scheduleMatches(s, ist('2026-09-28T18:00:00'))).toBe(false);
    expect(scheduleMatches(s, ist('2026-09-28T08:59:00'))).toBe(false);
  });
  it('does not answer on a day it does not list', () => {
    expect(scheduleMatches(s, ist('2026-10-04T12:00:00'))).toBe(false); // Sunday
  });
  it('reads the times in its own zone, not UTC', () => {
    // 04:00 UTC is 09:30 in Kolkata.
    expect(scheduleMatches(s, new Date('2026-09-28T04:00:00Z'))).toBe(true);
  });
});

describe('an overnight window belongs to the day it starts on', () => {
  const night = row({ inboundProfileId: NIGHT, startTime: '21:00', endTime: '09:00' });

  it('answers the evening part on a listed day', () => {
    expect(scheduleMatches(night, ist('2026-09-28T22:30:00'))).toBe(true); // Mon night
  });
  it('answers the early hours of the day after a listed day', () => {
    expect(scheduleMatches(night, ist('2026-09-29T02:00:00'))).toBe(true); // Tue 02:00, from Mon
  });
  it('answers Saturday 02:00 because Friday night is listed', () => {
    expect(scheduleMatches(night, ist('2026-10-03T02:00:00'))).toBe(true);
  });
  it('does not answer Monday 02:00 — that night started on Sunday, which is not listed', () => {
    expect(scheduleMatches(night, ist('2026-09-28T02:00:00'))).toBe(false);
  });
  it('does not answer the daytime gap', () => {
    expect(scheduleMatches(night, ist('2026-09-29T12:00:00'))).toBe(false);
  });
  it('wraps Sunday night into Monday morning', () => {
    const sundayNight = row({ days: [7], startTime: '22:00', endTime: '06:00' });
    expect(scheduleMatches(sundayNight, ist('2026-09-28T03:00:00'))).toBe(true); // Mon 03:00
  });
});

describe('across a DST change the local wall clock is what counts', () => {
  const ny = row({ zone: 'America/New_York', days: [1, 2, 3, 4, 5, 6, 7] });
  it('opens at 09:00 local on the day clocks go back (1 Nov 2026)', () => {
    expect(scheduleMatches(ny, new Date('2026-11-01T14:00:00Z'))).toBe(true); // 09:00 EST
    expect(scheduleMatches(ny, new Date('2026-11-01T13:30:00Z'))).toBe(false); // 08:30 EST
  });
});

describe('scheduledProfileId', () => {
  it('uses the number default when nothing matches', () => {
    expect(scheduledProfileId([row({})], ist('2026-09-28T23:00:00'), DEFAULT)).toBe(DEFAULT);
  });
  it('uses the number default when there is no schedule at all', () => {
    expect(scheduledProfileId([], ist('2026-09-28T12:00:00'), DEFAULT)).toBe(DEFAULT);
  });
  it('picks the lowest priority where rows overlap', () => {
    const rows = [
      row({ id: 'nps_01BBBBBBBBBBBBBBBBBBBBBBBB', inboundProfileId: NIGHT, priority: 50 }),
      row({ id: 'nps_01AAAAAAAAAAAAAAAAAAAAAAAA', inboundProfileId: DAY, priority: 100 }),
    ];
    expect(scheduledProfileId(rows, ist('2026-09-28T12:00:00'), DEFAULT)).toBe(NIGHT);
  });
  it('breaks a priority tie by id, so row order never changes the answer', () => {
    const a = row({ id: 'nps_01AAAAAAAAAAAAAAAAAAAAAAAA', inboundProfileId: DAY });
    const b = row({ id: 'nps_01BBBBBBBBBBBBBBBBBBBBBBBB', inboundProfileId: NIGHT });
    const at = ist('2026-09-28T12:00:00');
    expect(scheduledProfileId([a, b], at, DEFAULT)).toBe(DAY);
    expect(scheduledProfileId([b, a], at, DEFAULT)).toBe(DAY);
  });
  it('skips a row with an unknown zone and falls back, never throwing on a live call', () => {
    const broken = row({ zone: 'Mars/Olympus_Mons' });
    expect(scheduledProfileId([broken], ist('2026-09-28T12:00:00'), DEFAULT)).toBe(DEFAULT);
  });
  it('can return null only when the number itself has no default and nothing matches', () => {
    expect(scheduledProfileId([row({})], ist('2026-09-28T23:00:00'), null)).toBeNull();
  });
});

describe('ProfileScheduleInput refuses what could not be evaluated', () => {
  const ok = {
    inbound_profile_id: DAY,
    zone: 'Asia/Kolkata',
    days: [1, 2, 3],
    start_time: '09:00',
    end_time: '18:00',
  };
  it('accepts a valid row and normalises days', () => {
    expect(ProfileScheduleInput.parse({ ...ok, days: [3, 1, 1, 2] }).days).toEqual([1, 2, 3]);
  });
  it.each([
    ['an unknown zone', { zone: 'Not/AZone' }],
    ['a malformed time', { start_time: '9:00' }],
    ['24:00', { end_time: '24:00' }],
    ['start equal to end', { end_time: '09:00' }],
    ['a weekday outside 1–7', { days: [0] }],
    ['no days', { days: [] }],
    ['a profile id of the wrong kind', { inbound_profile_id: 'num_01AAAAAAAAAAAAAAAAAAAAAAAA' }],
  ])('refuses %s', (_why, over) => {
    expect(ProfileScheduleInput.safeParse({ ...ok, ...over }).success).toBe(false);
  });
});
