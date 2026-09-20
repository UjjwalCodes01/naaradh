import { describe, expect, it } from 'vitest';
import { addMinutes } from '@naaradh/shared';
import { gateIntent } from '../../src/gate/index.js';
import {
  NOON_IST,
  approvedScript,
  attempt,
  codIntent,
  fakeDeps,
  fakeState,
  happyInput,
  leadIntent,
  poolNumber,
  tenant,
} from './harness.js';

describe('gate step 9: attempt limits', () => {
  it('a live attempt on the wire blocks a second dial', async () => {
    const state = fakeState({
      attempts: [
        attempt({ status: 'RINGING', dispatchedAt: addMinutes(NOON_IST, -1), endedAt: null }),
      ],
    });
    expect(await gateIntent(happyInput(), fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'attempts:too_soon',
    });
  });

  it('transactional gap is 10 minutes: blocked at 9m59s, allowed at 10m', async () => {
    const at = (m: number) =>
      fakeState({ attempts: [attempt({ dispatchedAt: addMinutes(NOON_IST, -m) })] });
    const intent = codIntent(addMinutes(NOON_IST, -20));
    expect(await gateIntent(happyInput({ intent }), fakeDeps(at(10 - 1 / 60)))).toMatchObject({
      ok: false,
      reason: 'attempts:too_soon',
    });
    expect((await gateIntent(happyInput({ intent }), fakeDeps(at(10)))).ok).toBe(true);
  });

  it('service gap is 2 hours', async () => {
    const state = fakeState({
      attempts: [attempt({ dispatchedAt: addMinutes(NOON_IST, -119) })],
      consents: [
        {
          id: 'c',
          purpose: 'service',
          source: 'form',
          capturedAt: addMinutes(NOON_IST, -200),
          expiresAt: null,
        },
      ],
    });
    const intent = leadIntent(addMinutes(NOON_IST, -150), { notAfter: addMinutes(NOON_IST, 600) });
    const r = await gateIntent(happyInput({ intent }), fakeDeps(state));
    expect(r).toMatchObject({ ok: false, reason: 'attempts:too_soon' });
    if (!r.ok) expect(r.retryAt?.toISOString()).toBe(addMinutes(NOON_IST, 1).toISOString());
  });

  it('max 2 per 24h', async () => {
    const state = fakeState({
      attempts: [
        attempt({ id: 'a1', dispatchedAt: addMinutes(NOON_IST, -20 * 60) }),
        attempt({ id: 'a2', dispatchedAt: addMinutes(NOON_IST, -60) }),
      ],
    });
    const r = await gateIntent(
      happyInput({ intent: codIntent(addMinutes(NOON_IST, -5)) }),
      fakeDeps(state),
    );
    expect(r).toMatchObject({ ok: false, reason: 'attempts:daily' });
    if (!r.ok) expect(r.retryAt?.toISOString()).toBe(addMinutes(NOON_IST, 4 * 60).toISOString());
  });

  it('max 3 lifetime, counting only attempts the customer could have noticed', async () => {
    const noticed = [1, 2, 3].map((d) =>
      attempt({ id: `a${String(d)}`, dispatchedAt: addMinutes(NOON_IST, -d * 24 * 60) }),
    );
    expect(
      await gateIntent(happyInput(), fakeDeps(fakeState({ attempts: noticed }))),
    ).toMatchObject({ ok: false, reason: 'attempts:lifetime' });
    const engineFailures = [1, 2, 3].map((d) =>
      attempt({
        id: `f${String(d)}`,
        status: 'FAILED',
        dispatchedAt: addMinutes(NOON_IST, -d * 24 * 60),
      }),
    );
    expect(
      (await gateIntent(happyInput(), fakeDeps(fakeState({ attempts: engineFailures })))).ok,
    ).toBe(true);
  });
});

describe('gate step 10: concurrency (E-29)', () => {
  it('refuses when the tenant is at its limit and says when to retry', async () => {
    const state = fakeState({ concurrency: { tenantInUse: 3, engineInUse: 3, engineMax: 20 } });
    const r = await gateIntent(happyInput(), fakeDeps(state));
    expect(r).toMatchObject({ ok: false, reason: 'concurrency:tenant' });
    if (!r.ok) expect(r.retryAt?.getTime()).toBe(NOON_IST.getTime() + 30_000);
  });

  it('refuses when the engine is at its limit', async () => {
    const state = fakeState({ concurrency: { tenantInUse: 0, engineInUse: 20, engineMax: 20 } });
    expect(await gateIntent(happyInput(), fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'concurrency:engine',
    });
  });

  it('holds the lease on a pass and releases it on a later failure', async () => {
    const pass = fakeState();
    const r = await gateIntent(happyInput(), fakeDeps(pass));
    expect(r.ok).toBe(true);
    expect(pass.concurrency.tenantInUse).toBe(1);
    expect(pass.released).toBe(0);
    if (r.ok) await r.lease.release();
    expect(pass.concurrency.tenantInUse).toBe(0);

    const noScript = fakeState({ scripts: new Map() });
    const f = await gateIntent(happyInput(), fakeDeps(noScript));
    expect(f).toMatchObject({ ok: false, reason: 'script:none_approved' });
    expect(noScript.released).toBe(1);
    expect(noScript.concurrency.tenantInUse).toBe(0);
  });
});

describe('gate step 11: CLI selection (E-28, Q-01)', () => {
  it('excludes numbers below the 25% answer-rate floor', async () => {
    const state = fakeState({ numbers: [poolNumber({ answerRate7d: 0.24 })] });
    expect(await gateIntent(happyInput(), fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'cli:none_available',
    });
    const ok = fakeState({ numbers: [poolNumber({ answerRate7d: 0.25 })] });
    expect((await gateIntent(happyInput(), fakeDeps(ok))).ok).toBe(true);
  });

  it('respects purpose_allowed set by a human — never a default', async () => {
    const state = fakeState({ numbers: [poolNumber({ purposeAllowed: [] })] });
    expect(await gateIntent(happyInput(), fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'cli:none_available',
    });
    const promoOnly = fakeState({ numbers: [poolNumber({ purposeAllowed: ['promotional'] })] });
    expect(await gateIntent(happyInput(), fakeDeps(promoOnly))).toMatchObject({
      ok: false,
      reason: 'cli:none_available',
    });
  });

  it('never uses a number from another region or another engine', async () => {
    const state = fakeState({
      numbers: [poolNumber({ region: 'US' }), poolNumber({ id: 'num_other', engine: 'other' })],
    });
    expect(await gateIntent(happyInput(), fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'cli:none_available',
    });
  });

  it('takes the first eligible candidate (adapter orders tenant-owned, least-recently-used first)', async () => {
    const state = fakeState({
      numbers: [
        poolNumber({ id: 'num_retired', status: 'retired' }),
        poolNumber({ id: 'num_good' }),
      ],
    });
    const r = await gateIntent(happyInput(), fakeDeps(state));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cli.id).toBe('num_good');
  });
});

describe('gate step 12 and the pass payload', () => {
  it('requires an approved script for the intent locale', async () => {
    const state = fakeState();
    state.scripts.delete('usc_01TESTUSECASEAAAAAAAAAAAAA:hi-IN');
    expect(await gateIntent(happyInput(), fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'script:none_approved',
    });
  });

  it('returns everything the dispatcher needs and nothing it must decide itself', async () => {
    const r = await gateIntent(happyInput(), fakeDeps(fakeState()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.engine).toBe('simulator');
    expect(r.cli.id).toBe(poolNumber().id);
    expect(r.script).toEqual(approvedScript());
    expect(r.amdMode).toBe('continue'); // transactional → tenant.amdModeTransactional
    expect(r.maxDurationSec).toBe(120); // cod_confirm
    expect(r.trace.steps).toHaveLength(13);
    expect(r.trace.steps.every((s) => s.ok)).toBe(true);
  });

  it('uses the promotional AMD mode for promotional calls (E-24)', async () => {
    const state = fakeState({
      consents: [
        {
          id: 'c',
          purpose: 'promotional',
          source: 'checkout',
          capturedAt: addMinutes(NOON_IST, -60),
          expiresAt: addMinutes(NOON_IST, 600),
        },
      ],
    });
    const r = await gateIntent(
      happyInput({
        intent: {
          ...happyInput().intent,
          useCase: 'abandoned_cart',
          purpose: 'promotional',
          notAfter: addMinutes(NOON_IST, 600),
        },
      }),
      fakeDeps(state),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.amdMode).toBe('hangup');
      expect(r.maxDurationSec).toBe(150);
    }
  });
});

describe('gate step 0: engine routing and circuit breaker (E-20)', () => {
  it('holds intents when the primary engine is circuit-open and no failover is allowed', async () => {
    const r = await gateIntent(
      happyInput(),
      fakeDeps(fakeState({ circuitOpen: new Set(['simulator']) })),
    );
    expect(r).toMatchObject({ ok: false, reason: 'engine:circuit_open' });
    if (!r.ok) expect(r.retryAt?.getTime()).toBe(NOON_IST.getTime() + 60_000);
  });

  it('fails over to the secondary only for tenants flagged multi_engine_ok', async () => {
    const state = fakeState({
      circuitOpen: new Set(['simulator']),
      numbers: [poolNumber({ engine: 'simulator-secondary' })],
    });
    const r = await gateIntent(
      happyInput({ tenant: tenant({ multiEngineOk: true }) }),
      fakeDeps(state),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.engine).toBe('simulator-secondary');
    expect(r.trace.steps[0]?.detail).toMatchObject({ failover_from: 'simulator' });
  });

  it('honours a tenant engine override', async () => {
    const state = fakeState({ numbers: [poolNumber({ engine: 'pinned' })] });
    const r = await gateIntent(
      happyInput({ tenant: tenant({ engineOverride: 'pinned' }) }),
      fakeDeps(state),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.engine).toBe('pinned');
  });

  it('gates an unroutable region rather than guessing an engine', async () => {
    const r = await gateIntent(
      happyInput({ intent: codIntent(addMinutes(NOON_IST, -5), { recipientRegion: 'ZZ' }) }),
      fakeDeps(fakeState()),
    );
    expect(r).toMatchObject({ ok: false, reason: 'engine:unroutable' });
  });
});
