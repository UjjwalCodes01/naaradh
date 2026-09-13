import { describe, expect, it } from 'vitest';
import { addDays, addMinutes } from '@naaradh/shared';
import { gateIntent } from '../../src/gate/index.js';
import {
  NOON_IST,
  cartIntent,
  consent,
  contact,
  fakeDeps,
  fakeState,
  happyInput,
  tenant,
} from './harness.js';

describe('gate step 1: tenant status and billing (E-50, E-61)', () => {
  it.each(['paused', 'suspended', 'uninstalled'] as const)(
    '%s tenants place no calls',
    async (status) => {
      const r = await gateIntent(happyInput({ tenant: tenant({ status }) }), fakeDeps(fakeState()));
      expect(r).toMatchObject({ ok: false, reason: 'tenant:inactive' });
    },
  );

  it('E-50: a frozen subscription keeps dialling during the 3-day grace, then pauses', async () => {
    const inGrace = tenant({ billingStatus: 'frozen', billingGraceUntil: addDays(NOON_IST, 1) });
    expect((await gateIntent(happyInput({ tenant: inGrace }), fakeDeps(fakeState()))).ok).toBe(
      true,
    );
    const graceOver = tenant({
      billingStatus: 'frozen',
      billingGraceUntil: addMinutes(NOON_IST, -1),
    });
    expect(
      await gateIntent(happyInput({ tenant: graceOver }), fakeDeps(fakeState())),
    ).toMatchObject({ ok: false, reason: 'billing:frozen' });
  });

  it('E-61: a capped Shopify subscription pauses dispatch', async () => {
    const r = await gateIntent(
      happyInput({ tenant: tenant({ billingStatus: 'capped' }) }),
      fakeDeps(fakeState()),
    );
    expect(r).toMatchObject({ ok: false, reason: 'billing:capped' });
  });

  it('no billing at all means no calls', async () => {
    const r = await gateIntent(
      happyInput({ tenant: tenant({ billingStatus: 'none' }) }),
      fakeDeps(fakeState()),
    );
    expect(r).toMatchObject({ ok: false, reason: 'billing:not_set_up' });
  });
});

describe('gate step 2: kill switches in order (invariant 12)', () => {
  it('global beats engine beats tenant beats campaign', async () => {
    const all = fakeState({
      killSwitches: new Set([
        'global:*',
        'engine:simulator',
        `tenant:${tenant().id}`,
        'campaign:cmp_x',
      ]),
    });
    const intent = cartIntent(addMinutes(NOON_IST, -60), { campaignId: 'cmp_x' });
    expect(await gateIntent(happyInput({ intent }), fakeDeps(all))).toMatchObject({
      ok: false,
      reason: 'kill:global',
    });
    all.killSwitches.delete('global:*');
    expect(await gateIntent(happyInput({ intent }), fakeDeps(all))).toMatchObject({
      ok: false,
      reason: 'kill:engine',
    });
    all.killSwitches.delete('engine:simulator');
    expect(await gateIntent(happyInput({ intent }), fakeDeps(all))).toMatchObject({
      ok: false,
      reason: 'kill:tenant',
    });
    all.killSwitches.delete(`tenant:${tenant().id}`);
    expect(await gateIntent(happyInput({ intent }), fakeDeps(all))).toMatchObject({
      ok: false,
      reason: 'kill:campaign',
    });
  });

  it('a kill switch on another tenant does not affect this one', async () => {
    const r = await gateIntent(
      happyInput(),
      fakeDeps(fakeState({ killSwitches: new Set(['tenant:ten_someoneelse']) })),
    );
    expect(r.ok).toBe(true);
  });
});

describe('gate step 3: spend caps (E-32)', () => {
  it('tenant daily cap', async () => {
    const state = fakeState({
      spent: { tenantDay: 2_000_00, tenantMonth: 0, engineDay: 0, globalDay: 0 },
    });
    const r = await gateIntent(happyInput(), fakeDeps(state));
    expect(r).toMatchObject({ ok: false, reason: 'cap:tenant_daily' });
    if (!r.ok) expect(r.retryAt?.toISOString()).toBe('2026-09-15T00:00:00.000Z');
  });

  it('tenant monthly cap', async () => {
    const state = fakeState({
      spent: { tenantDay: 0, tenantMonth: 40_000_00, engineDay: 0, globalDay: 0 },
    });
    expect(await gateIntent(happyInput(), fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'cap:tenant_monthly',
    });
  });

  it('engine and global daily caps', async () => {
    expect(
      await gateIntent(
        happyInput(),
        fakeDeps(
          fakeState({
            spent: { tenantDay: 0, tenantMonth: 0, engineDay: 50_000_00, globalDay: 0 },
          }),
        ),
      ),
    ).toMatchObject({ ok: false, reason: 'cap:engine_daily' });
    expect(
      await gateIntent(
        happyInput(),
        fakeDeps(
          fakeState({
            spent: { tenantDay: 0, tenantMonth: 0, engineDay: 0, globalDay: 200_000_00 },
          }),
        ),
      ),
    ).toMatchObject({ ok: false, reason: 'cap:global_daily' });
  });

  it('a tenant with no cap set is not capped', async () => {
    const state = fakeState({
      spent: { tenantDay: 9_999_999_00, tenantMonth: 0, engineDay: 0, globalDay: 0 },
    });
    const r = await gateIntent(
      happyInput({ tenant: tenant({ spendCapDailyPaise: null }) }),
      fakeDeps(state),
    );
    expect(r.ok).toBe(true);
  });
});

describe('gate step 4: number and contact (E-26, E-27, E-43, E-46)', () => {
  it('E-43: no phone on the order', async () => {
    const r = await gateIntent(
      happyInput({ contact: contact({ hasPhone: false }) }),
      fakeDeps(fakeState()),
    );
    expect(r).toMatchObject({ ok: false, reason: 'number:missing' });
  });

  it('E-27: an Indian landline is never dialled', async () => {
    const r = await gateIntent(
      happyInput({ contact: contact({ phoneType: 'landline' }) }),
      fakeDeps(fakeState()),
    );
    expect(r).toMatchObject({ ok: false, reason: 'number:landline' });
  });

  it('an unknown type is allowed by default and rejectable by flag', async () => {
    expect(
      (
        await gateIntent(
          happyInput({ contact: contact({ phoneType: 'unknown' }) }),
          fakeDeps(fakeState()),
        )
      ).ok,
    ).toBe(true);
    const strict = fakeState({ flags: new Map([['number.reject_unknown_type_in', true]]) });
    expect(
      await gateIntent(
        happyInput({ contact: contact({ phoneType: 'unknown' }) }),
        fakeDeps(strict),
      ),
    ).toMatchObject({ ok: false, reason: 'number:type_unknown' });
  });

  it('E-46: staff/test contacts are skipped', async () => {
    expect(
      await gateIntent(happyInput({ contact: contact({ skip: true }) }), fakeDeps(fakeState())),
    ).toMatchObject({ ok: false, reason: 'contact:skip' });
  });

  it('an erased contact is never dialled (E-10)', async () => {
    expect(
      await gateIntent(
        happyInput({ contact: contact({ erasedAt: NOON_IST }) }),
        fakeDeps(fakeState()),
      ),
    ).toMatchObject({ ok: false, reason: 'contact:erased' });
  });
});

describe('gate step 8: DND (E-04, Q-02)', () => {
  const promo = happyInput({ intent: cartIntent(addMinutes(NOON_IST, -60)) });

  it('promotional: registered → gated, unknown → gated (fail closed), not_registered → passes', async () => {
    expect(
      await gateIntent(promo, fakeDeps(fakeState({ consents: [consent()], dnd: 'registered' }))),
    ).toMatchObject({ ok: false, reason: 'dnd:registered' });
    expect(
      await gateIntent(promo, fakeDeps(fakeState({ consents: [consent()], dnd: 'unknown' }))),
    ).toMatchObject({ ok: false, reason: 'dnd:unknown' });
    expect(
      (
        await gateIntent(
          promo,
          fakeDeps(fakeState({ consents: [consent()], dnd: 'not_registered' })),
        )
      ).ok,
    ).toBe(true);
  });

  it('transactional: scrubbed by default (flag true), registered → gated, unknown → allowed', async () => {
    expect(
      await gateIntent(happyInput(), fakeDeps(fakeState({ dnd: 'registered' }))),
    ).toMatchObject({ ok: false, reason: 'dnd:registered' });
    expect((await gateIntent(happyInput(), fakeDeps(fakeState({ dnd: 'unknown' })))).ok).toBe(true);
  });

  it('transactional with the flag off: no scrub call is made at all', async () => {
    const state = fakeState({
      dnd: 'registered',
      flags: new Map([['dnd.scrub_transactional', false]]),
    });
    const r = await gateIntent(happyInput(), fakeDeps(state));
    expect(r.ok).toBe(true);
    expect(state.dndCalls).toBe(0);
  });
});
