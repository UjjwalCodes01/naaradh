import { describe, expect, it } from 'vitest';
import { gateIntent } from '../../src/gate/index.js';
import { platformCaps } from '../../src/adapters/index.js';
import { fakeDeps, fakeState, happyInput } from './harness.js';

/**
 * P6 — platform safety caps are per currency. Retell bills in dollars, Indian engines in
 * rupees, and one deployment can use both (an Indian merchant calling a US customer). A dollar
 * cap must trip on dollars alone, and a rupee cap must never be reached by adding cents to paise.
 */

describe('gate: engine and global caps are kept per currency (E-32, P6)', () => {
  it('an engine at its dollar cap is refused even with no rupee spend at all', async () => {
    const state = fakeState({ spentUsd: { engineDay: 600_00, globalDay: 0 } });
    const r = await gateIntent(happyInput(), fakeDeps(state));
    expect(r).toMatchObject({ ok: false, reason: 'cap:engine_daily' });
    expect(r.trace.steps.at(-1)?.detail).toMatchObject({ currency: 'USD', cap: 600_00 });
  });

  it('dollars below the dollar cap never count toward the rupee cap', async () => {
    const state = fakeState({
      spent: { tenantDay: 0, tenantMonth: 0, engineDay: 49_999_00, globalDay: 0 },
      spentUsd: { engineDay: 599_00, globalDay: 599_00 },
    });
    expect((await gateIntent(happyInput(), fakeDeps(state))).ok).toBe(true);
  });

  it('the global dollar cap trips on its own', async () => {
    const state = fakeState({ spentUsd: { engineDay: 0, globalDay: 2_400_00 } });
    expect(await gateIntent(happyInput(), fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'cap:global_daily',
    });
  });

  it('with no caps configured in a currency, that currency is uncapped', async () => {
    const state = fakeState({
      engineCapUsdCents: null,
      globalCapUsdCents: null,
      spentUsd: { engineDay: 10_000_000_00, globalDay: 10_000_000_00 },
    });
    expect((await gateIntent(happyInput(), fakeDeps(state))).ok).toBe(true);
  });
});

describe('platformCaps: configuration → per-currency caps', () => {
  it('builds rupee and dollar caps per engine, and global caps per currency', () => {
    const caps = platformCaps({
      engines: {
        defaultIn: 'simulator',
        defaultUs: 'retell',
        secondaryIn: null,
        secondaryUs: null,
        maxConcurrency: {},
      },
      engineDailyCapPaise: { simulator: 50_000_00, retell: 50_000_00 },
      globalDailyCapPaise: 200_000_00,
      engineDailyCapUsdCents: { retell: 600_00 },
      globalDailyCapUsdCents: 2_400_00,
    });
    expect(caps.engineDaily['retell']).toEqual([
      { minor: 50_000_00, currency: 'INR' },
      { minor: 600_00, currency: 'USD' },
    ]);
    expect(caps.engineDaily['simulator']).toEqual([{ minor: 50_000_00, currency: 'INR' }]);
    expect(caps.globalDaily).toEqual([
      { minor: 200_000_00, currency: 'INR' },
      { minor: 2_400_00, currency: 'USD' },
    ]);
  });
});

describe('gate: North American caller IDs must be A-attested (P6-ENG-2)', () => {
  const NOON_NY = new Date('2026-09-14T16:00:00Z');
  const usInput = async () => {
    const { codIntent, contact } = await import('./harness.js');
    const { addMinutes } = await import('@naaradh/shared');
    return happyInput({
      contact: contact({ timezone: 'America/New_York' }),
      intent: codIntent(addMinutes(NOON_NY, -5), { recipientRegion: 'US' }),
      now: NOON_NY,
    });
  };
  const usNumber = async (attestation: 'A' | 'B' | 'C' | null) => {
    const { poolNumber } = await import('./harness.js');
    const { FAKE_US } = await import('@naaradh/shared/test/fake-phones');
    return poolNumber({
      region: 'US',
      engine: 'simulator-us',
      e164: FAKE_US.transferTarget,
      attestation,
    });
  };

  it('an A-attested number is used', async () => {
    const r = await gateIntent(
      await usInput(),
      fakeDeps(fakeState({ numbers: [await usNumber('A')] })),
    );
    expect(r.ok).toBe(true);
  });

  it('B, C or never-checked numbers are not, and the trace says why', async () => {
    for (const a of ['B', 'C', null] as const) {
      const r = await gateIntent(
        await usInput(),
        fakeDeps(fakeState({ numbers: [await usNumber(a)] })),
      );
      expect(r, String(a)).toMatchObject({ ok: false, reason: 'cli:none_available' });
      expect(r.trace.steps.find((s) => s.step === 11)?.detail).toMatchObject({
        attestation_required: 'A',
        unattested: 1,
      });
    }
  });

  it('India needs no attestation: an unchecked number is used as before', async () => {
    expect((await gateIntent(happyInput(), fakeDeps(fakeState()))).ok).toBe(true);
  });
});
