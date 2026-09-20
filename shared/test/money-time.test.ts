import { describe, expect, it } from 'vitest';
import {
  addMoney,
  compareMoney,
  formatMoney,
  grossMargin,
  money,
  multiplyMoney,
  paise,
  rupees,
} from '../src/money.js';
import { fixedClock, inZone, parseHm } from '../src/time.js';

describe('money', () => {
  it('is integer minor units with a currency', () => {
    expect(rupees(8)).toEqual({ minor: 800, currency: 'INR' });
    expect(() => money(1.5, 'INR')).toThrow(TypeError);
    expect(() => money(100, 'inr')).toThrow(TypeError);
  });

  it('never mixes currencies', () => {
    expect(() => addMoney(paise(100), money(100, 'USD'))).toThrow(/cannot add/);
    expect(() => compareMoney(paise(100), money(100, 'USD'))).toThrow(/cannot compare/);
  });

  it('computes the SPEC §2.1 margin table', () => {
    // ₹4/min engine, 45-second call = ₹3.00 cost; ₹8 price → 62% GM
    expect(grossMargin(rupees(8), rupees(3))).toBeCloseTo(0.625, 3);
    expect(grossMargin(rupees(6), rupees(3.75))).toBeCloseTo(0.375, 3);
  });

  it('multiplies by integer quantities only', () => {
    expect(multiplyMoney(paise(800), 3)).toEqual(paise(2400));
    expect(() => multiplyMoney(paise(800), 1.5)).toThrow(TypeError);
  });

  it('formats for humans', () => {
    expect(formatMoney(rupees(1999))).toContain('1,999');
  });
});

describe('time', () => {
  it('fixedClock is stable and independent of the wall clock', () => {
    const c = fixedClock('2026-09-12T15:30:00Z');
    expect(c.now().toISOString()).toBe('2026-09-12T15:30:00.000Z');
    expect(() => fixedClock('nope')).toThrow(TypeError);
  });

  it('inZone converts to the recipient zone (IST = UTC+5:30)', () => {
    const ist = inZone(new Date('2026-09-12T15:30:00Z'), 'Asia/Kolkata');
    expect(ist.hour).toBe(21);
    expect(ist.minute).toBe(0);
    expect(() => inZone(new Date(), 'Mars/Olympus')).toThrow();
  });

  it('parseHm is strict', () => {
    expect(parseHm('09:00')).toEqual({ hour: 9, minute: 0 });
    expect(() => parseHm('9:00')).toThrow(TypeError);
    expect(() => parseHm('24:00')).toThrow(TypeError);
  });
});
