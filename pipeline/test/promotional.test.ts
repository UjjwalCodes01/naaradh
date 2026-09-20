import { describe, expect, it } from 'vitest';
import { abArmFor } from '@naaradh/compliance';
import { isoWeekOf, qaSampleKey, qaSampleSize } from '../src/admin/qa.js';
import { twoProportionPValue } from '../src/dashboard/ab.js';
import { explainCheckout, explainOutcome } from '../src/dashboard/explain.js';
import { roiSettingsOf } from '../src/dashboard/settings.js';
import { setupLocaleFor } from '../src/dashboard/setup.js';

describe('weekly QA sample (P4-OPS-1)', () => {
  it('ISO weeks, including the year boundary', () => {
    expect(isoWeekOf(new Date('2026-09-14T00:00:00Z'))).toBe('2026-W38');
    expect(isoWeekOf(new Date('2026-09-20T23:59:59Z'))).toBe('2026-W38');
    expect(isoWeekOf(new Date('2026-09-21T00:00:00Z'))).toBe('2026-W39');
    // 1 Jan 2027 is a Friday: still week 53 of 2026.
    expect(isoWeekOf(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(isoWeekOf(new Date('2027-01-04T00:00:00Z'))).toBe('2027-W01');
  });

  it('2% per tenant, at least 1, at most 20, never more than there are', () => {
    expect(qaSampleSize(0)).toBe(0);
    expect(qaSampleSize(1)).toBe(1);
    expect(qaSampleSize(49)).toBe(1);
    expect(qaSampleSize(51)).toBe(2);
    expect(qaSampleSize(500)).toBe(10);
    expect(qaSampleSize(5000)).toBe(20);
  });

  it('the rank is deterministic per (attempt, week) and changes between weeks', () => {
    const a = qaSampleKey('att_01', '2026-W38');
    expect(qaSampleKey('att_01', '2026-W38')).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(qaSampleKey('att_01', '2026-W39')).not.toBe(a);
  });
});

describe('A/B arms (ADR-0010 §8)', () => {
  it('same intent → same arm; roughly even split', () => {
    expect(abArmFor('int_same')).toBe(abArmFor('int_same'));
    let a = 0;
    for (let i = 0; i < 2000; i += 1) if (abArmFor(`int_${String(i)}`) === 'A') a += 1;
    expect(a).toBeGreaterThan(850);
    expect(a).toBeLessThan(1150);
  });

  it('two-proportion p-value', () => {
    expect(twoProportionPValue(0, 0, 1, 10)).toBeNull();
    expect(twoProportionPValue(50, 100, 50, 100)).toBeCloseTo(1, 5);
    expect(twoProportionPValue(0, 100, 0, 100)).toBe(1);
    const p = twoProportionPValue(60, 100, 40, 100);
    expect(p).not.toBeNull();
    expect(p ?? 1).toBeLessThan(0.01);
    // z = 0.566 → p = 0.571 (reference value from the normal table).
    expect(twoProportionPValue(52, 100, 48, 100)).toBeCloseTo(0.5716, 3);
    // z = 1.96 → p = 0.05.
    expect(twoProportionPValue(598, 1000, 554, 1000)).toBeCloseTo(0.047, 2);
  });
});

describe('explanations for the merchant', () => {
  it('every promotional outcome has a label', () => {
    for (const o of [
      'will_complete',
      'will_buy_later',
      'not_interested',
      'price_objection',
      'qualified',
      'feedback_given',
    ])
      expect(explainOutcome(o).explanation).not.toBe('');
  });

  it('checkout skips say why in business terms, including gate reasons', () => {
    expect(explainCheckout('skipped', 'consent:missing').explanation).toMatch(/consent/i);
    expect(explainCheckout('skipped', 'recently_called').explanation).toMatch(/7 days/);
    expect(explainCheckout('converted', null).label).toBe('Ordered');
    expect(explainCheckout('skipped', 'dnd:registered').explanation).not.toBe('dnd:registered');
  });
});

describe('ROI settings', () => {
  it('defaults and bounds', () => {
    expect(roiSettingsOf(null)).toEqual({ rtoCostPaise: null, attributionHours: 24 });
    expect(roiSettingsOf({ rto_cost_paise: 12000, attribution_hours: 48 })).toEqual({
      rtoCostPaise: 12000,
      attributionHours: 48,
    });
    expect(roiSettingsOf({ rto_cost_paise: -1, attribution_hours: 500 })).toEqual({
      rtoCostPaise: null,
      attributionHours: 24,
    });
  });
});

describe('a new merchant is set up in its own language (P6-CMP-2, ADR-0012 §3)', () => {
  it('maps a country to the language its customers speak', () => {
    expect(setupLocaleFor('IN')).toBe('hi-IN');
    expect(setupLocaleFor('us')).toBe('en-US');
    expect(setupLocaleFor('GB')).toBe('en-GB');
    expect(setupLocaleFor('IE')).toBe('en-GB');
    expect(setupLocaleFor('DE')).toBe('de-DE');
    expect(setupLocaleFor('AT')).toBe('de-DE');
    expect(setupLocaleFor('FR')).toBe('fr-FR');
    expect(setupLocaleFor('ES')).toBe('es-ES');
    expect(setupLocaleFor('MX')).toBe('es-ES');
    // Anything unmapped gets US English rather than Indian English or nothing at all.
    expect(setupLocaleFor('JP')).toBe('en-US');
    expect(setupLocaleFor('')).toBe('en-US');
  });
});
