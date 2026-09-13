import { describe, expect, it } from 'vitest';
import { PLANS, effectivePlan, formatMinor, type PlanTenant } from '../src/billing/plans.js';
import { fromRazorpayStatus, fromShopifyStatus } from '../src/billing/subscriptions.js';

const t = (o: Partial<PlanTenant> = {}): PlanTenant => ({
  planCode: null,
  inboundPlanCode: null,
  overrides: {},
  currency: 'INR',
  ...o,
});

describe('plan catalogue (SPEC §2.2, ADR-0008)', () => {
  it('matches the INR price book: fee, allowance, per extra', () => {
    expect(effectivePlan('outbound', t({ planCode: 'growth' }))).toMatchObject({
      currency: 'INR',
      feeMinor: 499_900,
      includedUnits: 500,
      unitMinor: 800,
    });
    expect(effectivePlan('outbound', t({ planCode: 'starter' }))).toMatchObject({
      includedUnits: 150,
      unitMinor: 1_000,
    });
    expect(effectivePlan('outbound', t({ planCode: 'scale' }))).toMatchObject({
      includedUnits: 1_500,
      unitMinor: 600,
    });
    expect(effectivePlan('inbound', t({ inboundPlanCode: 'inbound_scale' }))).toMatchObject({
      feeMinor: 1_499_900,
      includedUnits: 4_000,
      unitMinor: 400,
    });
  });

  it('no plan → nothing included, pessimistic starter price, no fee', () => {
    expect(effectivePlan('outbound', t())).toMatchObject({
      includedUnits: 0,
      unitMinor: 1_000,
      feeMinor: 0,
    });
    expect(effectivePlan('inbound', t({ planCode: 'growth' }))).toMatchObject({
      includedUnits: 0,
      unitMinor: 600,
      feeMinor: 0,
    });
    // An inbound code in the outbound slot does not count as an outbound plan.
    expect(effectivePlan('outbound', t({ planCode: 'inbound_growth' }))).toMatchObject({
      includedUnits: 0,
    });
  });

  it('USD view for merchants Shopify bills in dollars; overrides apply only in the tenant currency', () => {
    expect(effectivePlan('outbound', t({ planCode: 'growth' }), 'USD')).toMatchObject({
      currency: 'USD',
      feeMinor: 5_900,
      unitMinor: 10,
    });
    const custom = t({
      planCode: 'enterprise',
      overrides: {
        outcome_unit_minor: 450,
        outcome_included: 3_000,
        outbound_fee_minor: 2_500_000,
      },
    });
    expect(effectivePlan('outbound', custom)).toMatchObject({
      unitMinor: 450,
      includedUnits: 3_000,
      feeMinor: 2_500_000,
    });
    expect(effectivePlan('outbound', custom, 'USD')).toMatchObject({
      unitMinor: 6,
      includedUnits: 0,
    });
  });

  it('every plan has both currencies and sane numbers', () => {
    for (const p of Object.values(PLANS)) {
      for (const c of ['INR', 'USD'] as const) {
        expect(Number.isSafeInteger(p.prices[c].feeMinor)).toBe(true);
        expect(p.prices[c].unitMinor).toBeGreaterThan(0);
      }
    }
    expect(formatMinor(80_000, 'INR')).toBe('₹800.00');
    expect(formatMinor(10, 'USD')).toBe('$0.10');
  });
});

describe('provider status mapping', () => {
  it('Shopify: ACTIVE/FROZEN/terminal/pending', () => {
    expect(
      ['ACTIVE', 'FROZEN', 'CANCELLED', 'DECLINED', 'EXPIRED', 'PENDING'].map(fromShopifyStatus),
    ).toEqual(['active', 'frozen', 'cancelled', 'declined', 'expired', 'pending']);
  });

  it('Razorpay: payment trouble is frozen (grace), not cancelled', () => {
    expect(
      [
        'authenticated',
        'active',
        'pending',
        'halted',
        'paused',
        'cancelled',
        'completed',
        'expired',
        'created',
      ].map(fromRazorpayStatus),
    ).toEqual([
      'active',
      'active',
      'frozen',
      'frozen',
      'frozen',
      'cancelled',
      'cancelled',
      'expired',
      'pending',
    ]);
  });
});
