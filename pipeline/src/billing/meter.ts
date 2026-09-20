import { and, eq, sql } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import { newId } from '@naaradh/shared';
import { effectivePlan, planTenantOf } from './plans.js';

/**
 * Outbound outcome metering (SPEC §2.2, ADR-0008). A billable outcome (invariant 11 decides
 * WHICH are billable; this only decides HOW MUCH) becomes one ledger row:
 *
 *   within the plan's included outcomes for the period → unit 0 (usage, not revenue)
 *   beyond it                                          → the plan's per-outcome price
 *
 * Keyed by the outcome id (`billing_ledger_ref_uq`), so a redelivered call.ended never meters
 * twice. Serialised per tenant with an advisory lock so two outcomes finishing together cannot
 * both take the last included slot.
 */

export interface OutcomeMeter {
  readonly ledgerId: string;
  readonly included: boolean;
  readonly unitMinor: number;
  readonly duplicate: boolean;
}

export async function meterOutcome(
  tx: DbOrTx,
  input: {
    readonly tenantId: string;
    readonly outcomeId: string;
    readonly at: Date;
    readonly vendorCostMinor: number | null;
    readonly vendorCostCurrency: string | null;
  },
): Promise<OutcomeMeter> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`outcomes:${input.tenantId}`}))`);

  const [existing] = await tx
    .select({ id: schema.billingLedger.id, unitMinor: schema.billingLedger.unitMinor })
    .from(schema.billingLedger)
    .where(
      and(
        eq(schema.billingLedger.tenantId, input.tenantId),
        eq(schema.billingLedger.kind, 'outcome'),
        eq(schema.billingLedger.ref, input.outcomeId),
      ),
    )
    .limit(1);
  if (existing !== undefined)
    return {
      ledgerId: existing.id,
      included: Number(existing.unitMinor) === 0,
      unitMinor: Number(existing.unitMinor),
      duplicate: true,
    };

  const [tenant] = await tx
    .select({
      planCode: schema.tenants.planCode,
      inboundPlanCode: schema.tenants.inboundPlanCode,
      billingOverrides: schema.tenants.billingOverrides,
      currency: schema.tenants.currency,
      provider: schema.tenants.billingProvider,
    })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, input.tenantId))
    .limit(1);
  const plan = effectivePlan(
    'outbound',
    tenant === undefined
      ? { planCode: null, inboundPlanCode: null, overrides: {}, currency: 'INR' }
      : planTenantOf(tenant),
  );
  const period = input.at.toISOString().slice(0, 7);
  const [used] = await tx
    .select({ n: sql<number>`coalesce(sum(${schema.billingLedger.qty}), 0)::int` })
    .from(schema.billingLedger)
    .where(
      and(
        eq(schema.billingLedger.tenantId, input.tenantId),
        eq(schema.billingLedger.kind, 'outcome'),
        eq(schema.billingLedger.period, period),
      ),
    );
  const included = (used?.n ?? 0) < plan.includedUnits;
  const unitMinor = included ? 0 : plan.unitMinor;
  const ledgerId = newId('ledger');
  await tx.insert(schema.billingLedger).values({
    id: ledgerId,
    tenantId: input.tenantId,
    kind: 'outcome',
    ref: input.outcomeId,
    qty: 1,
    unitMinor,
    totalMinor: unitMinor,
    currency: tenant?.currency ?? 'INR',
    period,
    provider: tenant?.provider ?? 'manual',
    vendorCostMinor: input.vendorCostMinor,
    vendorCostCurrency: input.vendorCostCurrency,
    notes: included ? `included outcome (${plan.plan.code})` : `outcome (${plan.plan.code})`,
    createdAt: input.at,
  });
  return { ledgerId, included, unitMinor, duplicate: false };
}
