/**
 * The plan catalogue (SPEC §2.2, ADR-0008) — the one place prices live. Every amount is an
 * integer in minor units (paise / cents). `[DECISION — founder]`: the INR book is SPEC §2.2's
 * starting point; USD prices for Indian plans (Shopify merchants whose app-billing currency is
 * USD) are derived at ≈ ₹84/$ and rounded. Revise after the pilot (Q-17).
 *
 * A tenant may hold one outbound plan (`tenants.plan_code`) AND one support-line plan
 * (`tenants.inbound_plan_code`). Enterprise overrides live in `tenants.billing_overrides` —
 * service-role only, never in the merchant-editable `settings`.
 */

export type BillingCurrency = 'INR' | 'USD';
export type PlanKind = 'outbound' | 'inbound';

export interface PlanPrice {
  /** Recurring platform fee per 30 days. Charged by the provider's subscription, not by postings. */
  readonly feeMinor: number;
  /** Units (outcomes or minutes) included in the fee each period. */
  readonly includedUnits: number;
  /** Price per unit beyond the allowance. */
  readonly unitMinor: number;
}

export interface Plan {
  readonly code: string;
  readonly name: string;
  readonly kind: PlanKind;
  readonly unit: 'outcome' | 'minute';
  readonly prices: Readonly<Record<BillingCurrency, PlanPrice>>;
}

export const PLANS: Readonly<Record<string, Plan>> = {
  starter: {
    code: 'starter',
    name: 'Starter',
    kind: 'outbound',
    unit: 'outcome',
    prices: {
      INR: { feeMinor: 199_900, includedUnits: 150, unitMinor: 1_000 },
      USD: { feeMinor: 2_400, includedUnits: 150, unitMinor: 12 },
    },
  },
  growth: {
    code: 'growth',
    name: 'Growth',
    kind: 'outbound',
    unit: 'outcome',
    prices: {
      INR: { feeMinor: 499_900, includedUnits: 500, unitMinor: 800 },
      USD: { feeMinor: 5_900, includedUnits: 500, unitMinor: 10 },
    },
  },
  scale: {
    code: 'scale',
    name: 'Scale',
    kind: 'outbound',
    unit: 'outcome',
    prices: {
      INR: { feeMinor: 1_299_900, includedUnits: 1_500, unitMinor: 600 },
      USD: { feeMinor: 15_500, includedUnits: 1_500, unitMinor: 7 },
    },
  },
  /** Custom contracts: fee and allowance come from settings; the unit default is the floor. */
  enterprise: {
    code: 'enterprise',
    name: 'Enterprise',
    kind: 'outbound',
    unit: 'outcome',
    prices: {
      INR: { feeMinor: 0, includedUnits: 0, unitMinor: 500 },
      USD: { feeMinor: 0, includedUnits: 0, unitMinor: 6 },
    },
  },
  inbound_starter: {
    code: 'inbound_starter',
    name: 'Support line — Starter',
    kind: 'inbound',
    unit: 'minute',
    prices: {
      INR: { feeMinor: 249_900, includedUnits: 500, unitMinor: 600 },
      USD: { feeMinor: 3_000, includedUnits: 500, unitMinor: 7 },
    },
  },
  inbound_growth: {
    code: 'inbound_growth',
    name: 'Support line — Growth',
    kind: 'inbound',
    unit: 'minute',
    prices: {
      INR: { feeMinor: 699_900, includedUnits: 1_500, unitMinor: 500 },
      USD: { feeMinor: 8_300, includedUnits: 1_500, unitMinor: 6 },
    },
  },
  inbound_scale: {
    code: 'inbound_scale',
    name: 'Support line — Scale',
    kind: 'inbound',
    unit: 'minute',
    prices: {
      INR: { feeMinor: 1_499_900, includedUnits: 4_000, unitMinor: 400 },
      USD: { feeMinor: 17_900, includedUnits: 4_000, unitMinor: 5 },
    },
  },
};

/** Tenants with no plan are metered pessimistically: nothing included, starter prices. */
const NO_OUTBOUND = PLANS['starter'] as Plan;
const NO_INBOUND = PLANS['inbound_starter'] as Plan;

export function billingCurrencyOf(currency: string | null | undefined): BillingCurrency {
  return currency === 'USD' ? 'USD' : 'INR';
}

const nonNegativeInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

export interface EffectivePlan {
  readonly plan: Plan;
  readonly currency: BillingCurrency;
  readonly includedUnits: number;
  readonly unitMinor: number;
  readonly feeMinor: number;
}

/** The pricing columns of a tenant row (all service-role only). */
export interface PlanTenant {
  readonly planCode: string | null;
  readonly inboundPlanCode: string | null;
  readonly overrides: Readonly<Record<string, unknown>> | null | undefined;
  readonly currency: string | null | undefined;
}

/**
 * The plan in force for one direction, with enterprise overrides applied. Garbage overrides are
 * ignored, never trusted. A tenant with no plan of that kind gets NO allowance.
 */
export function effectivePlan(
  kind: PlanKind,
  tenant: PlanTenant,
  currencyOverride?: BillingCurrency,
): EffectivePlan {
  const o = tenant.overrides ?? {};
  // A support-line-only tenant may carry its inbound plan in plan_code.
  const code = kind === 'inbound' ? (tenant.inboundPlanCode ?? tenant.planCode) : tenant.planCode;
  const found = code !== null ? PLANS[code] : undefined;
  const hasPlan = found !== undefined && found.kind === kind;
  const plan = hasPlan ? found : kind === 'inbound' ? NO_INBOUND : NO_OUTBOUND;
  const currency = currencyOverride ?? billingCurrencyOf(tenant.currency);
  const price = plan.prices[currency];
  const keys =
    kind === 'inbound'
      ? {
          included: 'inbound_included_minutes',
          unit: 'inbound_unit_minor',
          fee: 'inbound_fee_minor',
        }
      : { included: 'outcome_included', unit: 'outcome_unit_minor', fee: 'outbound_fee_minor' };
  // Overrides are stated in the tenant's own currency; they apply only when billing in it.
  const own = currency === billingCurrencyOf(tenant.currency);
  const pick = (key: string) => (own ? nonNegativeInt(o[key]) : null);
  return {
    plan,
    currency,
    includedUnits: pick(keys.included) ?? (hasPlan ? price.includedUnits : 0),
    unitMinor: pick(keys.unit) ?? price.unitMinor,
    feeMinor: pick(keys.fee) ?? (hasPlan ? price.feeMinor : 0),
  };
}

/** Select these with a tenant row to call `effectivePlan`. */
export function planTenantOf(row: {
  readonly planCode: string | null;
  readonly inboundPlanCode: string | null;
  readonly billingOverrides: unknown;
  readonly currency: string;
}): PlanTenant {
  return {
    planCode: row.planCode,
    inboundPlanCode: row.inboundPlanCode,
    overrides: (row.billingOverrides ?? {}) as Record<string, unknown>,
    currency: row.currency,
  };
}

/** "₹8.00" / "$0.10" for descriptions and the dashboard. */
export function formatMinor(minor: number, currency: BillingCurrency): string {
  const major = minor / 100;
  return `${currency === 'INR' ? '₹' : '$'}${major.toFixed(2)}`;
}
