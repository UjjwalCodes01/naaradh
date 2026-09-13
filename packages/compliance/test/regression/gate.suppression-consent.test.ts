import { describe, expect, it } from 'vitest';
import { addDays, addMinutes } from '@naaradh/shared';
import { gateIntent } from '../../src/gate/index.js';
import {
  NOON_IST,
  cartIntent,
  codIntent,
  consent,
  contact,
  fakeDeps,
  fakeState,
  happyInput,
  leadIntent,
  suppression,
  tenant,
} from './harness.js';

describe('gate: suppressions are absolute (invariant 6)', () => {
  it('E-03: a prior opt-out blocks a brand-new COD order, even though COD is transactional', async () => {
    const state = fakeState({
      suppressions: [
        suppression({ purpose: 'all', reason: 'opt_out', until: addDays(NOON_IST, 80) }),
      ],
    });
    const r = await gateIntent(happyInput(), fakeDeps(state));
    expect(r).toMatchObject({ ok: false, reason: 'suppression:tenant' });
  });

  it('a GLOBAL suppression (DNC page, complaint, minor) outranks a tenant one in the recorded reason', async () => {
    const state = fakeState({
      suppressions: [
        suppression({ id: 'sup_t', scope: 'tenant' }),
        suppression({ id: 'sup_g', scope: 'global', reason: 'self_service' }),
      ],
    });
    const r = await gateIntent(happyInput(), fakeDeps(state));
    expect(r).toMatchObject({ ok: false, reason: 'suppression:global' });
    expect(r.trace.steps.at(-1)?.detail).toMatchObject({ suppression_id: 'sup_g' });
  });

  it('a purpose-scoped suppression blocks only that purpose', async () => {
    const state = fakeState({ suppressions: [suppression({ purpose: 'promotional' })] });
    expect((await gateIntent(happyInput(), fakeDeps(state))).ok).toBe(true);
    const promo = happyInput({ intent: cartIntent(addMinutes(NOON_IST, -60)) });
    state.consents = [consent()];
    expect(await gateIntent(promo, fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'suppression:tenant',
    });
  });

  it('E-26: an order-scoped wrong_number suppression blocks that order only', async () => {
    const state = fakeState({
      suppressions: [suppression({ reason: 'wrong_number', externalRef: 'order-1001' })],
    });
    expect(await gateIntent(happyInput(), fakeDeps(state))).toMatchObject({
      ok: false,
      reason: 'suppression:tenant',
    });
    const other = happyInput({
      intent: codIntent(addMinutes(NOON_IST, -5), { externalRef: 'order-1002' }),
    });
    expect((await gateIntent(other, fakeDeps(state))).ok).toBe(true);
  });

  it('an expired suppression no longer blocks (90-day re-eligibility)', async () => {
    const state = fakeState({ suppressions: [suppression({ until: addMinutes(NOON_IST, -1) })] });
    expect((await gateIntent(happyInput(), fakeDeps(state))).ok).toBe(true);
  });
});

describe('gate: promotional consent (invariant 5)', () => {
  const promo = (overrides = {}) =>
    happyInput({ intent: cartIntent(addMinutes(NOON_IST, -60), overrides) });

  it('E-71: no consent row → gated, never inferred from the order having a phone number', async () => {
    const r = await gateIntent(promo(), fakeDeps(fakeState()));
    expect(r).toMatchObject({ ok: false, reason: 'consent:missing' });
  });

  it('passes with a checkout consent captured inside 7 days', async () => {
    const r = await gateIntent(promo(), fakeDeps(fakeState({ consents: [consent()] })));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('a consent scoped to "all" purposes counts', async () => {
    const r = await gateIntent(
      promo(),
      fakeDeps(fakeState({ consents: [consent({ purpose: 'all' })] })),
    );
    expect(r.ok).toBe(true);
  });

  it('expires at exactly 7 days: valid one second before, gated one second after', async () => {
    const captured = addDays(NOON_IST, -7);
    const before = fakeState({
      consents: [consent({ capturedAt: captured, expiresAt: addMinutes(NOON_IST, 1 / 60) })],
    });
    expect((await gateIntent(promo(), fakeDeps(before))).ok).toBe(true);
    const after = fakeState({
      consents: [consent({ capturedAt: captured, expiresAt: addMinutes(NOON_IST, -1 / 60) })],
    });
    expect(await gateIntent(promo(), fakeDeps(after))).toMatchObject({
      ok: false,
      reason: 'consent:expired',
    });
  });

  it('E-08: a merchant attestation is never sufficient', async () => {
    const r = await gateIntent(
      promo(),
      fakeDeps(fakeState({ consents: [consent({ source: 'attestation' })] })),
    );
    expect(r).toMatchObject({ ok: false, reason: 'consent:source_insufficient' });
  });

  it('E-71: an imported (bought) list is never sufficient', async () => {
    const r = await gateIntent(
      promo(),
      fakeDeps(fakeState({ consents: [consent({ source: 'import' })] })),
    );
    expect(r).toMatchObject({ ok: false, reason: 'consent:source_insufficient' });
  });

  it('E-06: promotional to India requires the tenant to be DLT-linked', async () => {
    const r = await gateIntent(promo({}), fakeDeps(fakeState({ consents: [consent()] })));
    expect(r.ok).toBe(true);
    const unlinked = happyInput({
      tenant: tenant({ dltLinkedAt: null }),
      intent: cartIntent(addMinutes(NOON_IST, -60)),
    });
    expect(
      await gateIntent(unlinked, fakeDeps(fakeState({ consents: [consent()] }))),
    ).toMatchObject({ ok: false, reason: 'consent:dlt_not_linked' });
  });

  it('E-73: a tenant in its review window may place COD calls but not promotional ones', async () => {
    const reviewing = tenant({ status: 'pending_review', reviewUntil: addDays(NOON_IST, 5) });
    expect((await gateIntent(happyInput({ tenant: reviewing }), fakeDeps(fakeState()))).ok).toBe(
      true,
    );
    const r = await gateIntent(
      happyInput({ tenant: reviewing, intent: cartIntent(addMinutes(NOON_IST, -60)) }),
      fakeDeps(fakeState({ consents: [consent()] })),
    );
    expect(r).toMatchObject({ ok: false, reason: 'tenant:pending_review_promotional' });
    if (!r.ok) expect(r.retryAt).toEqual(reviewing.reviewUntil);
  });
});

describe('gate: recipient region wins (invariant 2, E-07)', () => {
  const usContact = contact({ timezone: 'America/New_York' });
  /** 12:00 New York on 2026-09-14 (EDT, UTC-4) = 16:00 UTC. */
  const NOON_NY = new Date('2026-09-14T16:00:00Z');

  it('an Indian merchant marketing to a US number needs WRITTEN consent, a checkout tick is not enough', async () => {
    const intent = cartIntent(addMinutes(NOON_NY, -60), { recipientRegion: 'US' });
    const tick = fakeState({
      consents: [consent({ source: 'checkout', expiresAt: null })],
      numbers: [],
    });
    expect(
      await gateIntent(happyInput({ contact: usContact, intent, now: NOON_NY }), fakeDeps(tick)),
    ).toMatchObject({ ok: false, reason: 'consent:source_insufficient' });
    const written = fakeState({
      consents: [consent({ source: 'checkout_written', expiresAt: null })],
      numbers: [],
    });
    const r = await gateIntent(
      happyInput({ contact: usContact, intent, now: NOON_NY }),
      fakeDeps(written),
    );
    // Consent passes; the fake has no US numbers, so it fails later at CLI selection — which
    // is the point: the US rules, not the Indian ones, were applied to an Indian merchant.
    expect(r).toMatchObject({ ok: false, reason: 'cli:none_available' });
    expect(r.trace.steps.find((s) => s.step === 6)?.ok).toBe(true);
  });

  it('a US transactional call needs no consent row (prior express consent by giving the number)', async () => {
    const intent = codIntent(addMinutes(NOON_NY, -5), { recipientRegion: 'US' });
    const r = await gateIntent(
      happyInput({ contact: usContact, intent, now: NOON_NY }),
      fakeDeps(fakeState({ numbers: [] })),
    );
    expect(r.trace.steps.find((s) => s.step === 6)).toMatchObject({ ok: true });
  });

  it('an EU number needs opt-in even for a transactional call (ePrivacy 13(3))', async () => {
    const deContact = contact({ timezone: 'Europe/Berlin' });
    const NOON_BERLIN = new Date('2026-09-14T10:00:00Z');
    const intent = codIntent(addMinutes(NOON_BERLIN, -5), { recipientRegion: 'DE' });
    const r = await gateIntent(
      happyInput({ contact: deContact, intent, now: NOON_BERLIN }),
      fakeDeps(fakeState({ numbers: [] })),
    );
    expect(r).toMatchObject({ ok: false, reason: 'consent:missing' });
  });

  it("E-51: the window is the recipient's zone — noon IST is 02:30 in New York and gated", async () => {
    const intent = codIntent(addMinutes(NOON_IST, -5), { recipientRegion: 'US' });
    const r = await gateIntent(
      happyInput({ contact: usContact, intent }),
      fakeDeps(fakeState({ numbers: [] })),
    );
    expect(r).toMatchObject({ ok: false, reason: 'window:closed_transactional' });
    expect(r.trace.steps.at(-1)?.detail).toMatchObject({
      zones: 'America/New_York',
      basis: 'contact_zone',
    });
  });

  it('a US number with no zone hint uses the coast-to-coast intersection', async () => {
    // 09:30 in New York (13:30Z on 2026-09-14) is 06:30 in Los Angeles: open on one coast,
    // closed on the other → closed, and rescheduled to 08:00 PT = 15:00Z.
    const now = new Date('2026-09-14T13:30:00Z');
    const intent = leadIntent(addMinutes(now, -5), {
      recipientRegion: 'US',
      notAfter: addMinutes(now, 600),
    });
    const state = fakeState({
      consents: [consent({ purpose: 'service', source: 'form', expiresAt: null })],
      numbers: [],
    });
    const r = await gateIntent(
      happyInput({ contact: contact({ timezone: null }), intent, now }),
      fakeDeps(state),
    );
    expect(r).toMatchObject({ ok: false, reason: 'window:closed' });
    if (!r.ok) expect(r.retryAt?.toISOString()).toBe('2026-09-14T15:00:00.000Z');
    expect(r.trace.steps.at(-1)?.detail).toMatchObject({ basis: 'country_intersection' });
  });
});
