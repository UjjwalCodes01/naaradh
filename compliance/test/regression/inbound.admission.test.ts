import { describe, expect, it } from 'vitest';
import {
  admitInbound,
  inboundConcurrencyKey,
  type AdmissionDeps,
  type AdmissionInput,
} from '../../src/inbound/admission.js';
import { INBOUND_DEFAULT_MONTHLY_MINUTE_CAP } from '../../src/constants.js';

/**
 * Invariant 1 (inbound half) and E-80/81/88/92: admission is ordered, first failure wins,
 * and a refusal is always a fallback the caller can hear — never silence.
 */

const NOW = new Date('2026-09-14T06:30:00Z');
const T = 'ten_01INBOUNDTENANTAAAAAAAAAA';

function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    now: NOW,
    number: {
      id: 'num_1',
      tenantId: T,
      inboundProfileId: 'ipr_1',
      engine: 'simulator',
      status: 'active',
      inboundEnabled: true,
    },
    tenant: { id: T, status: 'active', billingStatus: 'active', billingGraceUntil: null },
    profile: {
      id: 'ipr_1',
      status: 'active',
      maxConcurrent: 2,
      maxCallsPerCallerHour: 6,
      monthlyMinuteCap: 1000,
      hasFallbackForward: true,
    },
    callerHash: 'a'.repeat(64),
    ...overrides,
  };
}

interface FakeState {
  kills: Set<string>;
  minutes: number;
  callerCalls: number;
  circuitOpen: boolean;
  inUse: Map<string, number>;
  engineInUse: number;
  engineMax: number;
  callerHits: number;
}

function deps(state: Partial<FakeState> = {}): AdmissionDeps & { state: FakeState } {
  const s: FakeState = {
    kills: new Set(),
    minutes: 10,
    callerCalls: 1,
    circuitOpen: false,
    inUse: new Map(),
    engineInUse: 0,
    engineMax: 20,
    callerHits: 0,
    ...state,
  };
  return {
    state: s,
    killSwitches: { isActive: async (scope, key) => s.kills.has(`${scope}:${key}`) },
    minutesUsedThisMonth: async () => s.minutes,
    callerCallsLastHour: async () => {
      s.callerHits += 1;
      return s.callerCalls;
    },
    isEngineCircuitOpen: async () => s.circuitOpen,
    engineMaxConcurrency: () => s.engineMax,
    concurrency: {
      tryAcquire: async (tenantKey, tenantMax, _engine, engineMax) => {
        const used = s.inUse.get(tenantKey) ?? 0;
        if (used >= tenantMax) return { ok: false, which: 'tenant' };
        if (s.engineInUse >= engineMax) return { ok: false, which: 'engine' };
        s.inUse.set(tenantKey, used + 1);
        s.engineInUse += 1;
        return {
          ok: true,
          lease: {
            tenantSlot: tenantKey,
            engineSlot: 'e',
            release: async () => {
              s.inUse.set(tenantKey, (s.inUse.get(tenantKey) ?? 1) - 1);
              s.engineInUse -= 1;
            },
          },
        };
      },
    },
  };
}

describe('inbound admission — happy path', () => {
  it('admits, holds an INBOUND concurrency slot, and records every step', async () => {
    const d = deps();
    const r = await admitInbound(input(), d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({
      tenantId: T,
      profileId: 'ipr_1',
      numberId: 'num_1',
      engine: 'simulator',
    });
    expect(d.state.inUse.get(inboundConcurrencyKey(T))).toBe(1);
    // Inbound slots never share the tenant's outbound key.
    expect(d.state.inUse.has(T)).toBe(false);
    expect(r.trace.map((s) => s.name)).toEqual([
      'number',
      'tenant',
      'kill',
      'minutes',
      'abuse',
      'engine',
      'concurrency',
    ]);
    expect(r.trace.every((s) => s.ok)).toBe(true);
  });

  it('admits a withheld caller (E-80) without rate-keying them', async () => {
    const d = deps();
    const r = await admitInbound(input({ callerHash: null }), d);
    expect(r.ok).toBe(true);
    expect(d.state.callerHits).toBe(0);
    expect(r.trace.find((s) => s.name === 'abuse')?.detail).toEqual({ withheld: true });
  });

  it('admits a tenant still in its review window — answering customers is not promotional', async () => {
    const r = await admitInbound(
      input({
        tenant: {
          id: T,
          status: 'pending_review',
          billingStatus: 'active',
          billingGraceUntil: null,
        },
      }),
      deps(),
    );
    expect(r.ok).toBe(true);
  });
});

describe('step 1 — the number decides the tenant (invariant 16, E-81)', () => {
  it.each([
    ['unknown number', { number: null }],
    [
      'number with no tenant',
      {
        number: {
          id: 'num_1',
          tenantId: null,
          inboundProfileId: 'ipr_1',
          engine: 'simulator',
          status: 'active' as const,
          inboundEnabled: true,
        },
      },
    ],
    [
      'inbound disabled on the number',
      {
        number: {
          id: 'num_1',
          tenantId: T,
          inboundProfileId: 'ipr_1',
          engine: 'simulator',
          status: 'active' as const,
          inboundEnabled: false,
        },
      },
    ],
    [
      'retired number',
      {
        number: {
          id: 'num_1',
          tenantId: T,
          inboundProfileId: 'ipr_1',
          engine: 'simulator',
          status: 'retired' as const,
          inboundEnabled: true,
        },
      },
    ],
    [
      'no profile routed',
      {
        number: {
          id: 'num_1',
          tenantId: T,
          inboundProfileId: null,
          engine: 'simulator',
          status: 'active' as const,
          inboundEnabled: true,
        },
      },
    ],
  ])('%s → closed message, never a guessed tenant', async (_name, overrides) => {
    const r = await admitInbound(input(overrides), deps());
    expect(r).toMatchObject({ ok: false, reason: 'inbound:number_unrouted', fallback: 'closed' });
  });

  it('a draft or disabled profile → closed', async () => {
    for (const status of ['draft', 'disabled'] as const) {
      const r = await admitInbound(input({ profile: { ...input().profile!, status } }), deps());
      expect(r).toMatchObject({
        ok: false,
        reason: 'inbound:profile_inactive',
        fallback: 'closed',
      });
    }
  });

  it('a profile that is not the one routed on the number → refused', async () => {
    const r = await admitInbound(
      input({ profile: { ...input().profile!, id: 'ipr_other' } }),
      deps(),
    );
    expect(r).toMatchObject({ ok: false, reason: 'inbound:profile_inactive' });
  });
});

describe('step 2 — tenant and billing (E-92 fallback)', () => {
  it.each(['paused', 'suspended', 'uninstalled'] as const)(
    '%s tenant → forward to the merchant',
    async (status) => {
      const r = await admitInbound(
        input({ tenant: { id: T, status, billingStatus: 'active', billingGraceUntil: null } }),
        deps(),
      );
      expect(r).toMatchObject({
        ok: false,
        reason: 'inbound:tenant_inactive',
        fallback: 'forward',
      });
    },
  );

  it('a tenant id that does not match the number owner → refused', async () => {
    const r = await admitInbound(
      input({
        tenant: {
          id: 'ten_someoneelse',
          status: 'active',
          billingStatus: 'active',
          billingGraceUntil: null,
        },
      }),
      deps(),
    );
    expect(r).toMatchObject({ ok: false, reason: 'inbound:tenant_inactive' });
  });

  it('frozen billing answers during grace and forwards after it', async () => {
    const inGrace = await admitInbound(
      input({
        tenant: {
          id: T,
          status: 'active',
          billingStatus: 'frozen',
          billingGraceUntil: new Date(NOW.getTime() + 60_000),
        },
      }),
      deps(),
    );
    expect(inGrace.ok).toBe(true);
    const after = await admitInbound(
      input({
        tenant: {
          id: T,
          status: 'active',
          billingStatus: 'frozen',
          billingGraceUntil: new Date(NOW.getTime() - 60_000),
        },
      }),
      deps(),
    );
    expect(after).toMatchObject({ ok: false, reason: 'inbound:billing', fallback: 'forward' });
  });

  it('without a fallback number, a forward becomes a closed message — never silence', async () => {
    const r = await admitInbound(
      input({
        tenant: { id: T, status: 'paused', billingStatus: 'active', billingGraceUntil: null },
        profile: { ...input().profile!, hasFallbackForward: false },
      }),
      deps(),
    );
    expect(r).toMatchObject({ ok: false, fallback: 'closed' });
  });
});

describe('step 3 — inbound kill switches (invariant 12)', () => {
  it('inbound:* and inbound:<tenant> both stop answering', async () => {
    expect(await admitInbound(input(), deps({ kills: new Set(['inbound:*']) }))).toMatchObject({
      ok: false,
      reason: 'inbound:kill',
      fallback: 'forward',
    });
    expect(await admitInbound(input(), deps({ kills: new Set([`inbound:${T}`]) }))).toMatchObject({
      ok: false,
      reason: 'inbound:kill',
    });
  });

  it('a GLOBAL OUTBOUND kill switch does not stop the agent answering customers', async () => {
    const r = await admitInbound(input(), deps({ kills: new Set(['global:*', `tenant:${T}`]) }));
    expect(r.ok).toBe(true);
  });
});

describe('step 4 — monthly minutes (E-92)', () => {
  it('forwards once the cap is reached', async () => {
    expect((await admitInbound(input(), deps({ minutes: 999 }))).ok).toBe(true);
    expect(await admitInbound(input(), deps({ minutes: 1000 }))).toMatchObject({
      ok: false,
      reason: 'inbound:minute_cap',
      fallback: 'forward',
    });
  });

  it('a profile without a cap still has the platform safety cap', async () => {
    const noCap = input({ profile: { ...input().profile!, monthlyMinuteCap: null } });
    expect(
      await admitInbound(noCap, deps({ minutes: INBOUND_DEFAULT_MONTHLY_MINUTE_CAP })),
    ).toMatchObject({ ok: false, reason: 'inbound:minute_cap' });
  });
});

describe('step 6 — caller abuse (E-88)', () => {
  it('the Nth call inside an hour is allowed, the N+1th gets the abuse message — not the merchant', async () => {
    expect((await admitInbound(input(), deps({ callerCalls: 6 }))).ok).toBe(true);
    const r = await admitInbound(input(), deps({ callerCalls: 7 }));
    expect(r).toMatchObject({ ok: false, reason: 'inbound:abuse', fallback: 'abuse' });
  });

  it('an abusive caller never takes a concurrency slot', async () => {
    const d = deps({ callerCalls: 50 });
    await admitInbound(input(), d);
    expect(d.state.inUse.size).toBe(0);
  });
});

describe('steps 7 and 5 — engine health and concurrency', () => {
  it('an open breaker forwards to the merchant', async () => {
    expect(await admitInbound(input(), deps({ circuitOpen: true }))).toMatchObject({
      ok: false,
      reason: 'inbound:engine_down',
      fallback: 'forward',
    });
  });

  it('all lines busy → forward; a released slot admits the next caller', async () => {
    const d = deps();
    const a = await admitInbound(input(), d);
    const b = await admitInbound(input(), d);
    const c = await admitInbound(input(), d);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(c).toMatchObject({ ok: false, reason: 'inbound:concurrency', fallback: 'forward' });
    if (a.ok) await a.lease.release();
    expect((await admitInbound(input(), d)).ok).toBe(true);
  });

  it('engine-wide capacity is respected even when the tenant has free lines', async () => {
    const r = await admitInbound(input(), deps({ engineInUse: 20, engineMax: 20 }));
    expect(r).toMatchObject({ ok: false, reason: 'inbound:concurrency' });
  });
});
