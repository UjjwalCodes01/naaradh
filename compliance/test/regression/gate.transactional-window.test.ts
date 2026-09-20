import { describe, expect, it } from 'vitest';
import { addMinutes } from '@naaradh/shared';
import { gateIntent } from '../../src/gate/index.js';
import { codIntent, fakeDeps, fakeState, happyInput, istInstant, leadIntent } from './harness.js';

/**
 * Invariants 3 and 4 at their boundaries. Every instant below is IST expressed in UTC; the
 * gate never sees the merchant's zone, only the recipient's (IN → Asia/Kolkata).
 */
describe('gate: transactional 30-minute envelope (invariant 4)', () => {
  it('passes at event_ts + 29m59s', async () => {
    const eventTs = istInstant('2026-09-14', '12:00');
    const now = addMinutes(eventTs, 30 - 1 / 60); // 29m59s
    const r = await gateIntent(
      happyInput({ intent: codIntent(eventTs), now }),
      fakeDeps(fakeState()),
    );
    expect(r.ok).toBe(true);
  });

  it('gates at event_ts + 30m01s with window:transactional_expired and never reschedules', async () => {
    const eventTs = istInstant('2026-09-14', '12:00');
    const now = addMinutes(eventTs, 30 + 1 / 60);
    const r = await gateIntent(
      happyInput({ intent: codIntent(eventTs), now }),
      fakeDeps(fakeState()),
    );
    expect(r).toMatchObject({ ok: false, reason: 'window:transactional_expired', retryAt: null });
  });

  it('records the earlier checks in the trace even when step 6 fails', async () => {
    const eventTs = istInstant('2026-09-14', '12:00');
    const r = await gateIntent(
      happyInput({ intent: codIntent(eventTs), now: addMinutes(eventTs, 45) }),
      fakeDeps(fakeState()),
    );
    expect(r.ok).toBe(false);
    expect(r.trace.steps.map((s) => s.step)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(r.trace.steps.at(-1)).toMatchObject({
      step: 6,
      ok: false,
      reason: 'window:transactional_expired',
    });
  });

  it('E-02: an order at 22:30 IST is inside 30 minutes but outside the window → gated, not re-queued', async () => {
    const eventTs = istInstant('2026-09-14', '22:30');
    const now = addMinutes(eventTs, 3);
    const r = await gateIntent(
      happyInput({ intent: codIntent(eventTs), now }),
      fakeDeps(fakeState()),
    );
    expect(r).toMatchObject({ ok: false, reason: 'window:closed_transactional', retryAt: null });
  });
});

describe('gate: India calling window 09:00–21:00 IST (invariant 3)', () => {
  const cases: readonly [string, boolean, string][] = [
    ['08:59:59', false, 'one second before opening'],
    ['09:00:00', true, 'exactly at opening'],
    ['20:54:59', true, 'one second before the 5-minute close buffer'],
    ['20:55:00', false, 'E-01: at the buffer, a call could run past 21:00'],
    ['20:59:59', false, 'inside the buffer'],
    ['21:00:00', false, 'exactly at close'],
  ];

  for (const [hm, expected, why] of cases) {
    it(`${expected ? 'dials' : 'gates'} at ${hm} IST — ${why}`, async () => {
      const now = istInstant('2026-09-14', hm);
      // Order placed 3 minutes earlier, so the 30-minute envelope is never the reason.
      const r = await gateIntent(
        happyInput({ intent: codIntent(addMinutes(now, -3)), now }),
        fakeDeps(fakeState()),
      );
      if (expected) {
        expect(r.ok, JSON.stringify(r)).toBe(true);
      } else {
        expect(r).toMatchObject({ ok: false, reason: 'window:closed_transactional' });
      }
    });
  }

  it('E-01: an order at 20:50 dials immediately with a dial deadline of 20:55', async () => {
    const eventTs = istInstant('2026-09-14', '20:50');
    const now = addMinutes(eventTs, 2); // not_before = +2m
    const r = await gateIntent(
      happyInput({ intent: codIntent(eventTs), now }),
      fakeDeps(fakeState()),
    );
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.dialDeadline.toISOString()).toBe(istInstant('2026-09-14', '20:55').toISOString());
  });

  it('the dial deadline is the 30-minute envelope when that comes first', async () => {
    const eventTs = istInstant('2026-09-14', '12:00');
    const now = addMinutes(eventTs, 5);
    const r = await gateIntent(
      happyInput({ intent: codIntent(eventTs), now }),
      fakeDeps(fakeState()),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dialDeadline.toISOString()).toBe(addMinutes(eventTs, 30).toISOString());
  });

  it('a service call outside the window is rescheduled to the next opening, never dialled now', async () => {
    const now = istInstant('2026-09-14', '22:00');
    const state = fakeState({
      consents: [
        {
          id: 'c',
          purpose: 'service',
          source: 'form',
          capturedAt: addMinutes(now, -10),
          expiresAt: addMinutes(now, 7 * 24 * 60),
        },
      ],
    });
    const r = await gateIntent(
      happyInput({
        intent: leadIntent(addMinutes(now, -5), { notAfter: addMinutes(now, 24 * 60) }),
        now,
      }),
      fakeDeps(state),
    );
    expect(r).toMatchObject({ ok: false, reason: 'window:closed' });
    if (!r.ok)
      expect(r.retryAt?.toISOString()).toBe(istInstant('2026-09-15', '09:00').toISOString());
  });

  it('never dials before not_before', async () => {
    const eventTs = istInstant('2026-09-14', '12:00');
    const r = await gateIntent(
      happyInput({ intent: codIntent(eventTs), now: addMinutes(eventTs, 1) }),
      fakeDeps(fakeState()),
    );
    expect(r).toMatchObject({ ok: false, reason: 'intent:too_early' });
    if (!r.ok) expect(r.retryAt?.toISOString()).toBe(addMinutes(eventTs, 2).toISOString());
  });
});
