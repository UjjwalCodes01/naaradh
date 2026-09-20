import { describe, expect, it } from 'vitest';
import { gateIntent } from '../../src/gate/index.js';
import { admitInbound, type AdmissionDeps } from '../../src/inbound/admission.js';
import { fakeDeps, fakeState, happyInput, tenant } from './harness.js';

/**
 * ADR-0012 / E-142 — one deployment serves one region. A tenant whose data lives elsewhere is
 * never dialled here and never answered here, whatever else is true about it. Today every
 * deployment and every tenant is `in`, so these tests are the proof that the guard is wired
 * before a second region exists, not after.
 */

const NOW = new Date('2026-09-14T06:30:00Z');

describe('gate: a tenant from another region is never dialled here (E-142)', () => {
  it('refuses at step 1, before any spend, kill switch or number is considered', async () => {
    const r = await gateIntent(happyInput({ tenant: tenant({ dataRegion: 'us' }) }), {
      ...fakeDeps(fakeState()),
      dataRegion: 'in',
    });
    expect(r).toMatchObject({ ok: false, reason: 'tenant:other_region' });
    // The trace names both regions, so a misrouted request is obvious in the dashboard.
    expect(r.trace.steps.find((s) => s.step === 1)?.detail).toMatchObject({
      tenant_region: 'us',
      deployment_region: 'in',
    });
    // Nothing past the tenant step ran.
    expect(r.trace.steps.filter((s) => s.step > 1)).toEqual([]);
  });

  it('a tenant in this region is unaffected', async () => {
    const r = await gateIntent(happyInput({ tenant: tenant({ dataRegion: 'in' }) }), {
      ...fakeDeps(fakeState()),
      dataRegion: 'in',
    });
    expect(r.ok).toBe(true);
  });

  it('a deployment with no region configured (dev, tests) checks nothing', async () => {
    const r = await gateIntent(
      happyInput({ tenant: tenant({ dataRegion: 'eu' }) }),
      fakeDeps(fakeState()),
    );
    expect(r.ok).toBe(true);
  });

  it('the refusal is permanent — a retry cannot fix a routing mistake', async () => {
    const r = await gateIntent(happyInput({ tenant: tenant({ dataRegion: 'eu' }) }), {
      ...fakeDeps(fakeState()),
      dataRegion: 'in',
    });
    expect(r).toMatchObject({ ok: false, retryAt: null });
  });
});

describe('inbound: a call for another region is not answered here (E-142, E-92)', () => {
  const deps: AdmissionDeps = {
    killSwitches: { isActive: async () => false },
    concurrency: {
      tryAcquire: async () => ({
        ok: true as const,
        lease: { tenantSlot: 't', engineSlot: 'e', release: async () => undefined },
      }),
    },
    minutesUsedThisMonth: async () => 0,
    callerCallsLastHour: async () => 1,
    isEngineCircuitOpen: async () => false,
    engineMaxConcurrency: () => 10,
  } as unknown as AdmissionDeps;

  const input = (dataRegion: string | undefined, tenantRegion: string) => ({
    now: NOW,
    number: {
      id: 'num_01SEEDNUMBER00000000000001',
      tenantId: 'ten_01SEEDTENANT00000000000001',
      inboundProfileId: 'ipr_01SEEDPROFILE0000000000001',
      engine: 'simulator',
      status: 'active' as const,
      inboundEnabled: true,
    },
    tenant: {
      id: 'ten_01SEEDTENANT00000000000001',
      status: 'active' as const,
      billingStatus: 'active' as const,
      billingGraceUntil: null,
      dataRegion: tenantRegion,
    },
    profile: {
      id: 'ipr_01SEEDPROFILE0000000000001',
      status: 'active' as const,
      maxConcurrent: 3,
      maxCallsPerCallerHour: 10,
      monthlyMinuteCap: null,
      hasFallbackForward: true,
    },
    callerHash: 'a'.repeat(64),
    ...(dataRegion === undefined ? {} : { dataRegion }),
  });

  it('forwards to the merchant rather than answering for a foreign tenant', async () => {
    const r = await admitInbound(input('in', 'eu'), deps);
    expect(r).toMatchObject({ ok: false, reason: 'inbound:other_region', fallback: 'forward' });
  });

  it('answers normally for a tenant in this region', async () => {
    expect((await admitInbound(input('in', 'in'), deps)).ok).toBe(true);
  });

  it('checks nothing when the deployment declares no region', async () => {
    expect((await admitInbound(input(undefined, 'us'), deps)).ok).toBe(true);
  });
});
