import { describe, expect, it } from 'vitest';
import { addMinutes } from '@naaradh/shared';
import { isBillable } from '../../src/billable.js';
import { consentExpiresAt, isSourceAcceptable } from '../../src/consent.js';
import { closesAt, isOpen, nextOpen, windowFor } from '../../src/gate/windows.js';
import { isRetryEligible, nextRetryAt } from '../../src/retry.js';
import { istInstant } from './harness.js';

describe('isBillable (invariant 11, E-25, E-40, E-60)', () => {
  const base = { answeredBy: 'human' as const, humanSpeechSec: 30, superseded: false };

  it.each(['confirmed', 'confirmed_with_changes', 'cancelled', 'rescheduled', 'booked'])(
    '%s by a human is billable',
    (outcome) => {
      expect(isBillable({ ...base, outcome })).toEqual({ billable: true, reason: 'ok' });
    },
  );

  it.each([
    'no_answer',
    'busy',
    'voicemail',
    'wrong_number',
    'opt_out',
    'inconclusive',
    'failed',
    'transferred',
    'callback_requested',
    'minor_answered',
  ])('%s is never billable', (outcome) => {
    expect(isBillable({ ...base, outcome })).toEqual({
      billable: false,
      reason: 'outcome_not_billable',
    });
  });

  it('a machine answer is never billable, whatever the extraction says', () => {
    expect(isBillable({ ...base, outcome: 'confirmed', answeredBy: 'machine' })).toEqual({
      billable: false,
      reason: 'not_human',
    });
    expect(isBillable({ ...base, outcome: 'confirmed', answeredBy: 'unknown' })).toEqual({
      billable: false,
      reason: 'not_human',
    });
  });

  it('E-25: a pocket answer with under 5s of speech is not billable; an engine that reports no speech metric is not penalised', () => {
    expect(isBillable({ ...base, outcome: 'confirmed', humanSpeechSec: 4 })).toEqual({
      billable: false,
      reason: 'min_human_speech',
    });
    expect(isBillable({ ...base, outcome: 'confirmed', humanSpeechSec: 5 })).toEqual({
      billable: true,
      reason: 'ok',
    });
    expect(isBillable({ ...base, outcome: 'confirmed', humanSpeechSec: null })).toEqual({
      billable: true,
      reason: 'ok',
    });
  });

  it('E-40: superseded beats everything', () => {
    expect(isBillable({ ...base, outcome: 'confirmed', superseded: true })).toEqual({
      billable: false,
      reason: 'superseded',
    });
  });
});

describe('retry policy (AGENTS §5.5)', () => {
  const inWindow = windowFor('IN', null);
  if (inWindow === null) throw new Error('IN window');

  it('eligibility: only soft failures retry; every billable outcome and every protective reason is final', () => {
    for (const r of ['no_answer', 'busy', 'amd_hangup', 'inconclusive', 'carrier_temp_fail'])
      expect(isRetryEligible(r), r).toBe(true);
    for (const r of [
      'wrong_number',
      'opt_out',
      'recording_refused',
      'minor_answered',
      'invalid_number',
      'confirmed',
      'cancelled',
      'outcome_superseded',
    ]) {
      expect(isRetryEligible(r), r).toBe(false);
    }
  });

  it('COD no-answer at minute 3 retries at minute 13, inside the same 30-minute envelope', () => {
    const eventTs = istInstant('2026-09-14', '12:00');
    const now = addMinutes(eventTs, 3);
    expect(
      nextRetryAt({
        now,
        purpose: 'transactional',
        notAfter: addMinutes(eventTs, 30),
        window: inWindow,
      })?.toISOString(),
    ).toBe(addMinutes(eventTs, 13).toISOString());
  });

  it('COD no-answer at minute 25 is exhausted: minute 35 is past not_after and the window is never widened', () => {
    const eventTs = istInstant('2026-09-14', '12:00');
    expect(
      nextRetryAt({
        now: addMinutes(eventTs, 25),
        purpose: 'transactional',
        notAfter: addMinutes(eventTs, 30),
        window: inWindow,
      }),
    ).toBeNull();
  });

  it('COD near close: a retry that would land in the buffer is exhausted, never moved to next morning', () => {
    const eventTs = istInstant('2026-09-14', '20:40');
    expect(
      nextRetryAt({
        now: addMinutes(eventTs, 7),
        purpose: 'transactional',
        notAfter: addMinutes(eventTs, 30),
        window: inWindow,
      }),
    ).toBeNull();
  });

  it('service retry crossing the close moves to the next opening if the envelope allows', () => {
    const now = istInstant('2026-09-14', '20:00');
    const r = nextRetryAt({
      now,
      purpose: 'service',
      notAfter: addMinutes(now, 24 * 60),
      window: inWindow,
    });
    expect(r?.toISOString()).toBe(istInstant('2026-09-15', '09:00').toISOString());
    expect(
      nextRetryAt({ now, purpose: 'service', notAfter: addMinutes(now, 60), window: inWindow }),
    ).toBeNull();
  });
});

describe('windows (invariants 2 & 3, E-51)', () => {
  it('India is a single zone with 09:00–21:00', () => {
    const w = windowFor('IN', 'America/New_York'); // a hint never overrides India
    expect(w).toMatchObject({ zones: ['Asia/Kolkata'], basis: 'india' });
  });

  it('a US contact zone is used only if plausible for the country', () => {
    expect(windowFor('US', 'America/Chicago')).toMatchObject({
      zones: ['America/Chicago'],
      basis: 'contact_zone',
    });
    expect(windowFor('US', 'Asia/Kolkata')).toMatchObject({ basis: 'country_intersection' });
    expect(windowFor('US', 'Not/AZone')).toMatchObject({ basis: 'country_intersection' });
  });

  it('unknown regions have no window', () => {
    expect(windowFor('ZZ', null)).toBeNull();
  });

  it('closesAt and nextOpen for India', () => {
    const w = windowFor('IN', null);
    if (w === null) throw new Error();
    const noon = istInstant('2026-09-14', '12:00');
    expect(closesAt(noon, w)?.toISOString()).toBe(istInstant('2026-09-14', '21:00').toISOString());
    expect(closesAt(istInstant('2026-09-14', '22:00'), w)).toBeNull();
    expect(nextOpen(istInstant('2026-09-14', '22:00'), w).toISOString()).toBe(
      istInstant('2026-09-15', '09:00').toISOString(),
    );
    expect(nextOpen(istInstant('2026-09-14', '03:00'), w).toISOString()).toBe(
      istInstant('2026-09-14', '09:00').toISOString(),
    );
    expect(isOpen(istInstant('2026-09-14', '20:56'), w, 5)).toBe(false);
    expect(isOpen(istInstant('2026-09-14', '20:56'), w, 0)).toBe(true);
  });

  it('US intersection: open only when both coasts are open', () => {
    const w = windowFor('US', null);
    if (w === null) throw new Error();
    // 2026-09-14: EDT = UTC-4, PDT = UTC-7. 08:00 PT = 11:00 ET = 15:00Z; 21:00 ET = 18:00 PT = 01:00Z next day.
    expect(isOpen(new Date('2026-09-14T14:59:00Z'), w)).toBe(false); // 10:59 ET / 07:59 PT
    expect(isOpen(new Date('2026-09-14T15:00:00Z'), w)).toBe(true); // 11:00 ET / 08:00 PT
    expect(isOpen(new Date('2026-09-15T00:59:00Z'), w)).toBe(true); // 20:59 ET / 17:59 PT
    expect(isOpen(new Date('2026-09-15T01:00:00Z'), w)).toBe(false); // 21:00 ET
    expect(nextOpen(new Date('2026-09-15T01:00:00Z'), w).toISOString()).toBe(
      '2026-09-15T15:00:00.000Z',
    );
  });
});

describe('consent policy by region', () => {
  it('India: 7-day expiry for explicit consent, none for transactional', () => {
    const at = new Date('2026-09-14T00:00:00Z');
    expect(consentExpiresAt('IN', 'promotional', at)?.toISOString()).toBe(
      '2026-09-21T00:00:00.000Z',
    );
    expect(consentExpiresAt('IN', 'transactional', at)).toBeNull();
    expect(consentExpiresAt('US', 'promotional', at)).toBeNull();
  });

  it('attestation and import are never acceptable anywhere', () => {
    for (const region of ['IN', 'US', 'DE', 'ZZ']) {
      expect(isSourceAcceptable(region, 'promotional', 'attestation')).toBe(false);
      expect(isSourceAcceptable(region, 'service', 'import')).toBe(false);
    }
  });
});
