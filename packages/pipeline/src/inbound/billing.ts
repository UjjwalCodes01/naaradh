import { and, eq, sql } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import { INBOUND_BILLING_ROUNDING_SEC } from '@naaradh/compliance';
import { newId } from '@naaradh/shared';
import { PLANS, effectivePlan, planTenantOf, type PlanTenant } from '../billing/plans.js';

/**
 * Inbound minute metering (ADR-0006 Q-17, SPEC §2.2). Inbound is billed per connected minute,
 * rounded UP per call, against the plan's included minutes; beyond them at the overage price.
 * Outbound outcome billing (invariant 11) is untouched — this is a separate ledger kind.
 *
 * Each call writes at most two ledger rows, keyed by the attempt so a redelivered call.ended
 * never bills twice (invariant 10):
 *
 *   ref = <attempt_id>           included minutes, unit price 0 — metering, not revenue
 *   ref = <attempt_id>:overage   minutes past the allowance, at the plan's overage price
 */

export interface InboundPlan {
  readonly includedMinutes: number;
  readonly overagePaise: number;
}

/** INR view of the support-line plans in the catalogue (billing/plans.ts). */
/**
 * INR reference table for the inbound plans, for docs and the dashboard's price list. Metering
 * does NOT use it: `inboundPlanFor()` reads the tenant's own currency through `effectivePlan`,
 * so a USD-billed tenant is metered in cents. Do not add a caller that meters from here.
 */
export const INBOUND_PLANS: Readonly<Record<string, InboundPlan>> = Object.fromEntries(
  Object.values(PLANS)
    .filter((p) => p.kind === 'inbound')
    .map((p) => [
      p.code,
      { includedMinutes: p.prices.INR.includedUnits, overagePaise: p.prices.INR.unitMinor },
    ]),
);

export function inboundPlanFor(tenant: PlanTenant): InboundPlan {
  const e = effectivePlan('inbound', tenant);
  return { includedMinutes: e.includedUnits, overagePaise: e.unitMinor };
}

export function billedMinutes(connectedSec: number | null): number {
  if (connectedSec === null || !Number.isFinite(connectedSec) || connectedSec <= 0) return 0;
  return Math.ceil(connectedSec / INBOUND_BILLING_ROUNDING_SEC);
}

export function billingPeriod(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** Minutes metered this period — admission step 4 reads this against the cap (E-92). */
export async function inboundMinutesUsed(tx: DbOrTx, tenantId: string, at: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(sum(${schema.billingLedger.qty}), 0)::int` })
    .from(schema.billingLedger)
    .where(
      and(
        eq(schema.billingLedger.tenantId, tenantId),
        eq(schema.billingLedger.kind, 'minute'),
        eq(schema.billingLedger.period, billingPeriod(at)),
      ),
    );
  return row?.n ?? 0;
}

export interface MeterResult {
  readonly minutes: number;
  readonly includedMinutes: number;
  readonly overageMinutes: number;
  readonly overageMinor: number;
  readonly duplicate: boolean;
}

export async function meterInboundCall(
  tx: DbOrTx,
  input: {
    tenantId: string;
    attemptId: string;
    connectedSec: number | null;
    at: Date;
    vendorCostMinor: number | null;
    vendorCostCurrency: string | null;
  },
): Promise<MeterResult> {
  const minutes = billedMinutes(input.connectedSec);
  if (minutes === 0)
    return { minutes: 0, includedMinutes: 0, overageMinutes: 0, overageMinor: 0, duplicate: false };

  // Two calls ending at once must not both spend the last included minutes.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`inbound_minutes:${input.tenantId}`}))`,
  );

  const [already] = await tx
    .select({ id: schema.billingLedger.id })
    .from(schema.billingLedger)
    .where(
      and(
        eq(schema.billingLedger.tenantId, input.tenantId),
        eq(schema.billingLedger.kind, 'minute'),
        eq(schema.billingLedger.ref, input.attemptId),
      ),
    )
    .limit(1);
  if (already !== undefined)
    return { minutes, includedMinutes: 0, overageMinutes: 0, overageMinor: 0, duplicate: true };

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
  const e = effectivePlan(
    'inbound',
    tenant === undefined
      ? { planCode: null, inboundPlanCode: null, overrides: {}, currency: 'INR' }
      : planTenantOf(tenant),
  );
  const plan = { includedMinutes: e.includedUnits, overagePaise: e.unitMinor };
  const used = await inboundMinutesUsed(tx, input.tenantId, input.at);
  const includedLeft = Math.max(0, plan.includedMinutes - used);
  const included = Math.min(minutes, includedLeft);
  const overage = minutes - included;
  const period = billingPeriod(input.at);
  const common = {
    tenantId: input.tenantId,
    kind: 'minute' as const,
    currency: tenant?.currency ?? 'INR',
    period,
    provider: tenant?.provider ?? 'manual',
  };

  // The included row is written even when it is 0 minutes: it is the idempotency marker.
  await tx
    .insert(schema.billingLedger)
    .values({
      id: newId('ledger'),
      ...common,
      ref: input.attemptId,
      qty: included,
      unitMinor: 0,
      totalMinor: 0,
      vendorCostMinor: input.vendorCostMinor,
      vendorCostCurrency: input.vendorCostCurrency,
      notes: `inbound ${String(minutes)} min (${String(included)} included)`,
      createdAt: input.at,
    })
    .onConflictDoNothing();
  if (overage > 0) {
    await tx
      .insert(schema.billingLedger)
      .values({
        id: newId('ledger'),
        ...common,
        ref: `${input.attemptId}:overage`,
        qty: overage,
        unitMinor: plan.overagePaise,
        totalMinor: plan.overagePaise * overage,
        notes: 'inbound overage',
        createdAt: input.at,
      })
      .onConflictDoNothing();
  }
  return {
    minutes,
    includedMinutes: included,
    overageMinutes: overage,
    overageMinor: plan.overagePaise * overage,
    duplicate: false,
  };
}
