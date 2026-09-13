import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import { effectivePlan, planTenantOf, type BillingCurrency } from './plans.js';

/**
 * What a merchant sees on the billing page (API + both dashboards): this period's allowance,
 * what was used, what is charged beyond it, and where the charges stand at the provider.
 * Tenant-scoped (app role, RLS).
 */

export interface DirectionUsage {
  readonly plan: string | null;
  readonly included: number;
  readonly used: number;
  readonly extra: number;
  readonly extraAmountMinor: number;
  readonly unitMinor: number;
  readonly feeMinor: number;
}

export interface UsageSummary {
  readonly period: string;
  readonly currency: BillingCurrency;
  readonly billingStatus: string;
  readonly billingProvider: string | null;
  readonly graceUntil: Date | null;
  readonly outbound: DirectionUsage;
  readonly inbound: DirectionUsage;
  readonly credits: number;
  readonly postings: Readonly<Record<string, number>>;
  readonly subscription: {
    readonly provider: string;
    readonly status: string;
    readonly currentPeriodEnd: Date | null;
    readonly cappedAmountMinor: number | null;
  } | null;
}

export async function usageSummary(tx: DbOrTx, tenantId: string, at: Date): Promise<UsageSummary> {
  const period = at.toISOString().slice(0, 7);
  const [tenant] = await tx
    .select({
      planCode: schema.tenants.planCode,
      inboundPlanCode: schema.tenants.inboundPlanCode,
      billingOverrides: schema.tenants.billingOverrides,
      currency: schema.tenants.currency,
      billingStatus: schema.tenants.billingStatus,
      billingProvider: schema.tenants.billingProvider,
      graceUntil: schema.tenants.billingGraceUntil,
    })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  if (tenant === undefined) throw new Error('tenant not found');
  const pt = planTenantOf(tenant);
  const rows = await tx
    .select({
      kind: schema.billingLedger.kind,
      qty: sql<number>`coalesce(sum(${schema.billingLedger.qty}), 0)::int`,
      total: sql<string>`coalesce(sum(${schema.billingLedger.totalMinor}), 0)`,
      charged: sql<number>`coalesce(sum(case when ${schema.billingLedger.totalMinor} > 0 then ${schema.billingLedger.qty} else 0 end), 0)::int`,
    })
    .from(schema.billingLedger)
    .where(
      and(eq(schema.billingLedger.tenantId, tenantId), eq(schema.billingLedger.period, period)),
    )
    .groupBy(schema.billingLedger.kind);
  const by = (k: string) => rows.find((r) => r.kind === k);

  const direction = (kind: 'outbound' | 'inbound'): DirectionUsage => {
    const e = effectivePlan(kind, pt);
    const r = by(kind === 'outbound' ? 'outcome' : 'minute');
    const hasPlan =
      kind === 'outbound' ? pt.planCode !== null : (pt.inboundPlanCode ?? pt.planCode) !== null;
    return {
      plan: hasPlan ? e.plan.code : null,
      included: e.includedUnits,
      used: r?.qty ?? 0,
      extra: r?.charged ?? 0,
      extraAmountMinor: Number(r?.total ?? 0),
      unitMinor: e.unitMinor,
      feeMinor: e.feeMinor,
    };
  };

  const postingRows = await tx
    .select({ status: schema.billingPostings.status, n: sql<number>`count(*)::int` })
    .from(schema.billingPostings)
    .where(
      and(eq(schema.billingPostings.tenantId, tenantId), eq(schema.billingPostings.period, period)),
    )
    .groupBy(schema.billingPostings.status);
  const [sub] = await tx
    .select({
      provider: schema.billingSubscriptions.provider,
      status: schema.billingSubscriptions.status,
      currentPeriodEnd: schema.billingSubscriptions.currentPeriodEnd,
      cappedAmountMinor: schema.billingSubscriptions.cappedAmountMinor,
    })
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.tenantId, tenantId))
    .orderBy(desc(schema.billingSubscriptions.createdAt))
    .limit(1);

  return {
    period,
    currency: effectivePlan('outbound', pt).currency,
    billingStatus: tenant.billingStatus,
    billingProvider: tenant.billingProvider,
    graceUntil: tenant.graceUntil,
    outbound: direction('outbound'),
    inbound: direction('inbound'),
    credits: -Number(by('credit')?.total ?? 0),
    postings: Object.fromEntries(postingRows.map((p) => [p.status, p.n])),
    subscription: sub ?? null,
  };
}
