import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { normalizePhone, zoneHintForNumber } from '@naaradh/shared';
import { FAKE_CA, FAKE_IN, FAKE_UK, FAKE_US } from '@naaradh/shared/test/fake-phones';
import { isFrenchPublicHoliday, isUsFederalHoliday } from '../../src/gate/holidays.js';
import { closesAt, isOpen, nextOpen, windowFor } from '../../src/gate/windows.js';

/**
 * P6-CMP-1 — calling windows outside India. Every rule here is the conservative intersection
 * of the rules we know of, marked [LEGAL] in constants.ts until the TCPA / ePrivacy review.
 * The tests pin the behaviour, so loosening a rule is a visible change, never a quiet one.
 *
 * Calendar used below (2026): 7 Sep Mon (Labor Day), 13 Sep Sun, 14 Sep Mon, 18 Sep Fri,
 * 19 Sep Sat, 21 Sep Mon; 4 Jul Sat (observed Fri 3 Jul); Easter Sun 5 Apr (Easter Mon 6 Apr).
 * In September New York is UTC-4, Paris and Berlin UTC+2, Toronto UTC-4.
 */

function mustWindow(...args: Parameters<typeof windowFor>) {
  const w = windowFor(...args);
  if (w === null) throw new Error(`no window for ${args.join(',')}`);
  return w;
}

describe('US: marketing is Monday–Saturday 09:00–20:00, never on a federal holiday', () => {
  const marketing = mustWindow('US', 'America/New_York', 'promotional');
  const service = mustWindow('US', 'America/New_York', 'transactional');

  it('a Sunday is closed for marketing but open for a call about the customer’s own order', () => {
    const sundayNoon = new Date('2026-09-13T16:00:00Z');
    expect(isOpen(sundayNoon, marketing)).toBe(false);
    expect(isOpen(sundayNoon, service)).toBe(true);
  });

  it('Labor Day and the observed Independence Day are closed for marketing', () => {
    expect(isOpen(new Date('2026-09-07T16:00:00Z'), marketing)).toBe(false);
    expect(isOpen(new Date('2026-07-03T16:00:00Z'), marketing)).toBe(false); // observed
    expect(isOpen(new Date('2026-07-04T16:00:00Z'), marketing)).toBe(false); // actual (Sat)
    expect(isOpen(new Date('2026-07-11T16:00:00Z'), marketing)).toBe(true); // an ordinary Saturday
    expect(isOpen(new Date('2026-09-08T16:00:00Z'), marketing)).toBe(true);
  });

  it('the hours are 09:00–20:00 for every purpose', () => {
    expect(isOpen(new Date('2026-09-14T12:59:00Z'), service)).toBe(false); // 08:59 ET
    expect(isOpen(new Date('2026-09-14T13:00:00Z'), service)).toBe(true); // 09:00 ET
    expect(isOpen(new Date('2026-09-14T23:59:00Z'), service)).toBe(true); // 19:59 ET
    expect(isOpen(new Date('2026-09-15T00:00:00Z'), service)).toBe(false); // 20:00 ET
  });

  it('after Saturday’s close, marketing next opens on Monday morning, skipping Sunday', () => {
    expect(nextOpen(new Date('2026-09-13T00:00:00Z'), marketing).toISOString()).toBe(
      '2026-09-14T13:00:00.000Z',
    );
  });
});

describe('Hawaii and Alaska: the recipient’s own zone, never the mainland intersection', () => {
  it('a Honolulu zone is trusted for a US number (it was once rejected as "not America/")', () => {
    expect(windowFor('US', 'Pacific/Honolulu')).toMatchObject({
      zones: ['Pacific/Honolulu'],
      basis: 'contact_zone',
    });
  });

  it('noon in New York is 06:00 in Honolulu — open in the intersection, closed for Hawaii', () => {
    const at = new Date('2026-09-14T16:00:00Z'); // 12:00 ET, 09:00 PT, 06:00 HST
    expect(isOpen(at, mustWindow('US', null))).toBe(true);
    expect(isOpen(at, mustWindow('US', 'Pacific/Honolulu'))).toBe(false);
  });

  it('the area code pins the zone when there is no shipping address', () => {
    const zoneOf = (e164: string) => {
      const parsed = normalizePhone(e164);
      if (!parsed.ok) throw new Error(parsed.reason);
      return zoneHintForNumber(parsed.phone);
    };
    expect(zoneOf(FAKE_US.hawaii)).toBe('Pacific/Honolulu');
    expect(zoneOf(FAKE_US.alaska)).toBe('America/Anchorage');
    expect(zoneOf(FAKE_CA.halifax)).toBe('America/Halifax');
    // Inside the mainland span, or not North American: no hint, the normal rules apply.
    expect(zoneOf(FAKE_US.customer)).toBeNull();
    expect(zoneOf(FAKE_IN.customer)).toBeNull();
    expect(zoneOf(FAKE_UK.customer)).toBeNull();
  });

  it('a zone from another country is still ignored', () => {
    expect(windowFor('US', 'Asia/Kolkata')).toMatchObject({ basis: 'country_intersection' });
    expect(windowFor('US', 'Europe/London')).toMatchObject({ basis: 'country_intersection' });
    expect(windowFor('CA', 'America/Halifax')).toMatchObject({ basis: 'contact_zone' });
  });
});

describe('France: marketing only on weekdays, 10:00–13:00 and 14:00–20:00 (Décret 2022-1313)', () => {
  const marketing = mustWindow('FR', null, 'promotional');

  it('the lunch gap is closed and both halves of the day are open', () => {
    expect(isOpen(new Date('2026-09-18T08:00:00Z'), marketing)).toBe(true); // 10:00
    expect(isOpen(new Date('2026-09-18T11:30:00Z'), marketing)).toBe(false); // 13:30
    expect(isOpen(new Date('2026-09-18T12:00:00Z'), marketing)).toBe(true); // 14:00
  });

  it('a call is dialled so that it ends before the lunch gap, not in it', () => {
    expect(closesAt(new Date('2026-09-18T08:30:00Z'), marketing)?.toISOString()).toBe(
      '2026-09-18T11:00:00.000Z',
    );
    expect(nextOpen(new Date('2026-09-18T11:00:00Z'), marketing).toISOString()).toBe(
      '2026-09-18T12:00:00.000Z',
    );
  });

  it('the weekend is closed; Friday evening next opens on Monday at 10:00', () => {
    expect(isOpen(new Date('2026-09-19T12:00:00Z'), marketing)).toBe(false);
    expect(nextOpen(new Date('2026-09-18T18:00:00Z'), marketing).toISOString()).toBe(
      '2026-09-21T08:00:00.000Z',
    );
  });

  it('Easter Monday is closed; the Tuesday after is open', () => {
    expect(isOpen(new Date('2026-04-06T12:00:00Z'), marketing)).toBe(false);
    expect(isOpen(new Date('2026-04-07T12:00:00Z'), marketing)).toBe(true);
  });

  it('a service call is not held to the marketing decree', () => {
    expect(isOpen(new Date('2026-09-19T12:00:00Z'), mustWindow('FR', null, 'transactional'))).toBe(
      true,
    );
  });
});

describe('Europe and Canada: no marketing at the weekend edges', () => {
  it('Germany: no marketing on Sunday; an appointment confirmation is fine', () => {
    const sundayNoon = new Date('2026-09-13T10:00:00Z');
    expect(isOpen(sundayNoon, mustWindow('DE', null, 'promotional'))).toBe(false);
    expect(isOpen(sundayNoon, mustWindow('DE', null, 'service'))).toBe(true);
  });

  it('Canada: marketing Monday to Friday only', () => {
    expect(
      isOpen(new Date('2026-09-19T16:00:00Z'), mustWindow('CA', 'America/Toronto', 'promotional')),
    ).toBe(false);
    expect(
      isOpen(new Date('2026-09-18T16:00:00Z'), mustWindow('CA', 'America/Toronto', 'promotional')),
    ).toBe(true);
  });

  it('India is unchanged: 09:00–21:00 every day, for every purpose', () => {
    const w = mustWindow('IN', null, 'promotional');
    expect(w.days).toBeNull();
    expect(w.holidays).toBeNull();
    expect(isOpen(new Date('2026-09-13T06:30:00Z'), w)).toBe(true); // Sunday noon IST
  });
});

describe('holiday calendars', () => {
  const ny = (iso: string) => DateTime.fromISO(iso, { zone: 'America/New_York' });
  const paris = (iso: string) => DateTime.fromISO(iso, { zone: 'Europe/Paris' });

  it('US federal holidays, including the floating ones and observed days', () => {
    for (const d of [
      '2026-01-01',
      '2026-01-19', // MLK Day
      '2026-02-16', // Washington's Birthday
      '2026-05-25', // Memorial Day
      '2026-06-19',
      '2026-07-03', // Independence Day observed
      '2026-09-07',
      '2026-10-12', // Columbus Day
      '2026-11-11',
      '2026-11-26', // Thanksgiving
      '2026-12-25',
      '2027-07-05', // 4 July 2027 is a Sunday → observed Monday
    ])
      expect(isUsFederalHoliday(ny(d)), d).toBe(true);
    for (const d of ['2026-09-08', '2026-11-27', '2026-12-24'])
      expect(isUsFederalHoliday(ny(d)), d).toBe(false);
  });

  it('French public holidays, Easter-based ones computed', () => {
    for (const d of [
      '2026-04-03',
      '2026-04-06',
      '2026-05-14',
      '2026-05-25',
      '2026-07-14',
      '2026-12-26',
    ])
      expect(isFrenchPublicHoliday(paris(d)), d).toBe(true);
    for (const d of ['2026-04-07', '2026-09-18'])
      expect(isFrenchPublicHoliday(paris(d)), d).toBe(false);
  });
});

describe('recording consent by recipient region (P6-CMP-1, Q-12)', () => {
  it('asks wherever every party must agree, and only notifies elsewhere', async () => {
    const { recordingConsentFor } = await import('../../src/constants.js');
    for (const r of ['US', 'DE', 'CH', 'AT']) expect(recordingConsentFor(r), r).toBe('ask');
    for (const r of ['IN', 'GB', 'FR', 'CA', 'ZZ'])
      expect(recordingConsentFor(r), r).toBe('notice');
  });

  it('the gate hands the mode to the dispatcher with every pass', async () => {
    const { gateIntent } = await import('../../src/gate/index.js');
    const { fakeDeps, fakeState, happyInput } = await import('./harness.js');
    const r = await gateIntent(happyInput(), fakeDeps(fakeState()));
    expect(r).toMatchObject({ ok: true, recordingConsent: 'notice' });
  });
});
