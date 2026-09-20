import { describe, expect, it } from 'vitest';
import { addDays, addMinutes } from '@naaradh/shared';
import { gateIntent } from '../../src/gate/index.js';
import { abArmFor } from '../../src/adapters/db.js';
import { MAX_ATTEMPTS_BY_USE_CASE, PROMOTIONAL_COOLDOWN_DAYS } from '../../src/constants.js';
import {
  NOON_IST,
  approvedScript,
  attempt,
  cartIntent,
  codIntent,
  consent,
  fakeDeps,
  fakeState,
  happyInput,
  istInstant,
} from './harness.js';

/**
 * Phase 4 promotional rules (ADR-0010). Each test starts from a promotional abandoned-cart
 * intent that passes, and breaks one thing.
 */

const cart = (overrides: Parameters<typeof cartIntent>[1] = {}) =>
  happyInput({ intent: cartIntent(addMinutes(NOON_IST, -60), overrides) });
const consented = (overrides: Parameters<typeof fakeState>[0] = {}) =>
  fakeState({ consents: [consent()], ...overrides });

describe('gate: promotional baseline (ADR-0010)', () => {
  it('a consented, DND-clear, DLT-linked abandoned-cart call with a registered template passes', async () => {
    const r = await gateIntent(cart(), fakeDeps(consented()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.script.dltTemplateId).toBe('1107160000000000001');
  });
});

describe('gate: one attempt per cart, one promotional call per phone per week (ADR-0010 §3)', () => {
  it('abandoned_cart is capped at 1 attempt: a no-answer is never followed by a second call', async () => {
    expect(MAX_ATTEMPTS_BY_USE_CASE.abandoned_cart).toBe(1);
    const state = consented({
      attempts: [attempt({ status: 'NO_ANSWER', dispatchedAt: addMinutes(NOON_IST, -300) })],
    });
    expect(await gateIntent(cart(), fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'attempts:lifetime',
    });
  });

  it('an attempt that never rang (engine failed at dispatch) does not use up the one attempt', async () => {
    const state = consented({
      attempts: [attempt({ status: 'FAILED', dispatchedAt: null })],
    });
    expect((await gateIntent(cart(), fakeDeps(state))).ok).toBe(true);
  });

  it('COD keeps its retry: the cap applies to promotional use cases only', async () => {
    const state = fakeState({
      attempts: [attempt({ status: 'NO_ANSWER', dispatchedAt: addMinutes(NOON_IST, -15) })],
    });
    const r = await gateIntent(
      happyInput({ intent: codIntent(addMinutes(NOON_IST, -20)) }),
      fakeDeps(state),
    );
    expect(r.ok).toBe(true);
  });

  it(`a promotional call to the same phone in the last ${String(PROMOTIONAL_COOLDOWN_DAYS)} days blocks another cart's call`, async () => {
    const state = consented({ lastPromotionalDial: addDays(NOON_IST, -3) });
    const r = await gateIntent(cart({ externalRef: 'checkout-other' }), fakeDeps(state));
    expect(r).toMatchObject({ ok: false, reason: 'attempts:promotional_cooldown' });
    if (!r.ok) expect(r.retryAt).toBeNull();
  });

  it('the cooldown ends after 7 days', async () => {
    const state = consented({ lastPromotionalDial: addDays(NOON_IST, -7.01) });
    expect((await gateIntent(cart(), fakeDeps(state))).ok).toBe(true);
  });

  it('the cooldown never touches transactional COD confirmation', async () => {
    const state = fakeState({ lastPromotionalDial: addDays(NOON_IST, -1) });
    expect((await gateIntent(happyInput(), fakeDeps(state))).ok).toBe(true);
  });
});

describe('gate: DLT content template (ADR-0010 §4, E-112)', () => {
  it('an Indian promotional call without a registered template is refused', async () => {
    const state = consented();
    state.scripts.set(
      'usc_01TESTUSECASEAAAAAAAAAAAAA:hi-IN',
      approvedScript({ dltTemplateId: null }),
    );
    expect(await gateIntent(cart(), fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'script:dlt_template_missing',
    });
    state.scripts.set(
      'usc_01TESTUSECASEAAAAAAAAAAAAA:hi-IN',
      approvedScript({ dltTemplateId: '  ' }),
    );
    expect(await gateIntent(cart(), fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'script:dlt_template_missing',
    });
  });

  it('transactional COD needs no content template', async () => {
    const state = fakeState();
    state.scripts.set(
      'usc_01TESTUSECASEAAAAAAAAAAAAA:hi-IN',
      approvedScript({ dltTemplateId: null }),
    );
    expect((await gateIntent(happyInput(), fakeDeps(state))).ok).toBe(true);
  });

  it('the refusal releases the concurrency lease it held', async () => {
    const state = consented();
    state.scripts.set(
      'usc_01TESTUSECASEAAAAAAAAAAAAA:hi-IN',
      approvedScript({ dltTemplateId: null }),
    );
    await gateIntent(cart(), fakeDeps(state));
    expect(state.concurrency.tenantInUse).toBe(0);
    expect(state.released).toBe(1);
  });
});

describe('gate: promotional pause after a complaint (ADR-0010 §5, E-113)', () => {
  it('the tenant pause stops promotional calls only', async () => {
    const state = consented();
    const paused = { promotionalPausedAt: addDays(NOON_IST, -1) };
    const promo = cart();
    expect(
      await gateIntent({ ...promo, tenant: { ...promo.tenant, ...paused } }, fakeDeps(state)),
    ).toMatchObject({ ok: false, reason: 'tenant:promotional_paused' });
    const cod = happyInput();
    expect(
      (await gateIntent({ ...cod, tenant: { ...cod.tenant, ...paused } }, fakeDeps(state))).ok,
    ).toBe(true);
  });
});

describe('gate: consent and DND stay fail-closed for promotional', () => {
  it('no consent row → consent:missing', async () => {
    expect(await gateIntent(cart(), fakeDeps(fakeState()))).toMatchObject({
      ok: false,
      reason: 'consent:missing',
    });
  });

  it('a checkout consent past its 7-day life is expired; one minute inside is live', async () => {
    const expired = consented({
      consents: [
        consent({ capturedAt: addDays(NOON_IST, -7), expiresAt: addMinutes(NOON_IST, -1) }),
      ],
    });
    expect(await gateIntent(cart(), fakeDeps(expired))).toMatchObject({
      ok: false,
      reason: 'consent:expired',
    });
    const live = consented({
      consents: [
        consent({ capturedAt: addDays(NOON_IST, -7), expiresAt: addMinutes(NOON_IST, 1) }),
      ],
    });
    expect((await gateIntent(cart(), fakeDeps(live))).ok).toBe(true);
  });

  it('a merchant attestation is never enough for promotional (E-08)', async () => {
    const state = consented({ consents: [consent({ source: 'attestation' })] });
    expect(await gateIntent(cart(), fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'consent:source_insufficient',
    });
  });

  it('an unknown DND result (no scrub provider yet) never lets a promotional call through', async () => {
    const state = consented({ dnd: 'unknown' });
    const r = await gateIntent(cart(), fakeDeps(state));
    expect(r).toMatchObject({ ok: false, reason: 'dnd:unknown' });
  });

  it('DND registered → refused for good (E-04)', async () => {
    const state = consented({ dnd: 'registered' });
    expect(await gateIntent(cart(), fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'dnd:registered',
    });
  });

  it('an unlinked DLT principal entity blocks promotional (E-06)', async () => {
    const state = consented();
    const input = cart();
    const r = await gateIntent(
      { ...input, tenant: { ...input.tenant, dltLinkedAt: null } },
      fakeDeps(state),
    );
    expect(r).toMatchObject({ ok: false, reason: 'consent:dlt_not_linked' });
  });
});

describe('gate: the abandoned-cart calling window (E-109)', () => {
  it('a cart abandoned at 20:40 IST is due at 21:25 — closed — and waits for 09:00 the next day', async () => {
    const abandoned = istInstant('2026-09-14', '20:40');
    const due = addMinutes(abandoned, 45);
    const input = happyInput({ intent: cartIntent(abandoned), now: due });
    const r = await gateIntent(input, fakeDeps(consented()));
    expect(r).toMatchObject({ ok: false, reason: 'window:closed' });
    if (!r.ok)
      expect(r.retryAt?.toISOString()).toBe(istInstant('2026-09-15', '09:00').toISOString());
    const morning = await gateIntent(
      happyInput({ intent: cartIntent(abandoned), now: istInstant('2026-09-15', '09:00') }),
      fakeDeps(consented()),
    );
    expect(morning.ok).toBe(true);
  });

  it('a cart past its 24-hour deadline has expired', async () => {
    const r = await gateIntent(
      happyInput({ intent: cartIntent(addMinutes(NOON_IST, -24 * 60 - 1)) }),
      fakeDeps(consented()),
    );
    expect(r).toMatchObject({ ok: false, reason: 'intent:expired' });
  });
});

describe('gate: A/B arms (ADR-0010 §8)', () => {
  const withArms = () => {
    const state = consented();
    state.scripts.delete('usc_01TESTUSECASEAAAAAAAAAAAAA:hi-IN');
    state.scripts.set(
      'usc_01TESTUSECASEAAAAAAAAAAAAA:hi-IN:A',
      approvedScript({ id: 'scr_A', abArm: 'A' }),
    );
    state.scripts.set(
      'usc_01TESTUSECASEAAAAAAAAAAAAA:hi-IN:B',
      approvedScript({ id: 'scr_B', abArm: 'B', version: 2 }),
    );
    return state;
  };

  it('the same intent always hears the same arm (a retry is not a second experiment)', async () => {
    const state = withArms();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const r = await gateIntent(cart({ id: 'int_01STABLEARMCHECKAAAAAAAAAA' }), fakeDeps(state));
      if (r.ok) {
        ids.add(r.script.id);
        await r.lease.release();
      }
    }
    expect(ids.size).toBe(1);
  });

  it('intents split roughly 50/50 across the two arms', () => {
    let a = 0;
    for (let i = 0; i < 2000; i += 1)
      if (abArmFor(`int_${String(i).padStart(26, '0')}`) === 'A') a += 1;
    expect(a / 2000).toBeGreaterThan(0.45);
    expect(a / 2000).toBeLessThan(0.55);
  });

  it('the chosen arm is recorded in the gate trace', async () => {
    const r = await gateIntent(cart(), fakeDeps(withArms()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.trace.steps.at(-1)?.detail).toMatchObject({ ab_arm: r.script.abArm });
  });
});
