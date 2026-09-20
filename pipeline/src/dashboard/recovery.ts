import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import { roiSettingsOf } from './settings.js';

/**
 * The recovered-revenue and ROI page (P4-WEB-2, ADR-0010 §9). Everything here is measured, not
 * billed: recoveries come from `attributions` (last touch, human-answered, within the window,
 * reversals excluded), and the COD figure is an estimate the merchant parameterises with their
 * own return-to-origin cost. Every number states what it counts so nobody mistakes an estimate
 * for an invoice. Tenant-scoped (app role, RLS).
 */

export interface MoneyByCurrency {
  readonly currency: string;
  readonly minor: number;
}

export interface RecoveryReport {
  readonly from: Date;
  readonly to: Date;
  readonly checkouts: {
    readonly total: number;
    readonly withPhone: number;
    readonly withConsent: number;
    readonly scheduled: number;
    readonly completedByThemselves: number;
    readonly converted: number;
    readonly expired: number;
    readonly waiting: number;
    readonly skipped: readonly { readonly reason: string; readonly count: number }[];
  };
  readonly calls: {
    readonly intents: number;
    readonly dialled: number;
    readonly answered: number;
    readonly outcomes: readonly { readonly outcome: string; readonly count: number }[];
  };
  readonly recovered: {
    readonly orders: number;
    readonly byCheckout: number;
    readonly byPhone: number;
    readonly reversed: number;
    readonly revenue: readonly MoneyByCurrency[];
    readonly windowHours: number;
  };
  readonly cod: {
    readonly confirmed: number;
    readonly cancelledBeforeShip: number;
    /** Cancelled-before-ship × the merchant's RTO cost; null when they have not set one. */
    readonly rtoAvoidedMinor: number | null;
    readonly rtoCostPaise: number | null;
  };
  /** Everything Naaradh charged in the range, per currency (outcomes, minutes, fees, credits). */
  readonly charges: readonly MoneyByCurrency[];
}

export async function recoveryReport(
  tx: DbOrTx,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<RecoveryReport> {
  const inRange = (col: typeof schema.checkouts.sourceCreatedAt) =>
    and(gte(col, from), lt(col, to));

  const [funnel] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      // An erased checkout keeps no phone; one that was called certainly had one (E-119).
      withPhone: sql<number>`count(*) filter (where ${schema.checkouts.phoneHash} is not null or ${schema.checkouts.intentId} is not null)::int`,
      withConsent: sql<number>`count(*) filter (where ${schema.checkouts.consentWording} is not null)::int`,
      scheduled: sql<number>`count(*) filter (where ${schema.checkouts.status} = 'scheduled')::int`,
      completed: sql<number>`count(*) filter (where ${schema.checkouts.status} = 'completed')::int`,
      converted: sql<number>`count(*) filter (where ${schema.checkouts.status} = 'converted')::int`,
      expired: sql<number>`count(*) filter (where ${schema.checkouts.status} = 'expired')::int`,
      waiting: sql<number>`count(*) filter (where ${schema.checkouts.status} = 'open')::int`,
    })
    .from(schema.checkouts)
    .where(and(eq(schema.checkouts.tenantId, tenantId), inRange(schema.checkouts.sourceCreatedAt)));
  const skipped = await tx
    .select({
      reason: sql<string>`coalesce(${schema.checkouts.skipReason}, 'unknown')`,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.checkouts)
    .where(
      and(
        eq(schema.checkouts.tenantId, tenantId),
        eq(schema.checkouts.status, 'skipped'),
        inRange(schema.checkouts.sourceCreatedAt),
      ),
    )
    .groupBy(schema.checkouts.skipReason)
    .orderBy(sql`count(*) desc`);

  const [intents] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.callIntents)
    .where(
      and(
        eq(schema.callIntents.tenantId, tenantId),
        eq(schema.callIntents.useCase, 'abandoned_cart'),
        gte(schema.callIntents.createdAt, from),
        lt(schema.callIntents.createdAt, to),
      ),
    );
  const cartAttempts = and(
    eq(schema.callAttempts.tenantId, tenantId),
    eq(schema.callIntents.useCase, 'abandoned_cart'),
    gte(schema.callAttempts.createdAt, from),
    lt(schema.callAttempts.createdAt, to),
  );
  const [calls] = await tx
    .select({
      dialled: sql<number>`count(*) filter (where ${schema.callAttempts.dispatchedAt} is not null)::int`,
      answered: sql<number>`count(*) filter (where ${schema.callAttempts.answeredBy} = 'human')::int`,
    })
    .from(schema.callAttempts)
    .innerJoin(schema.callIntents, eq(schema.callIntents.id, schema.callAttempts.intentId))
    .where(cartAttempts);
  const outcomes = await tx
    .select({ outcome: schema.callOutcomes.outcome, count: sql<number>`count(*)::int` })
    .from(schema.callOutcomes)
    .innerJoin(schema.callAttempts, eq(schema.callAttempts.id, schema.callOutcomes.attemptId))
    .innerJoin(schema.callIntents, eq(schema.callIntents.id, schema.callAttempts.intentId))
    .where(cartAttempts)
    .groupBy(schema.callOutcomes.outcome)
    .orderBy(sql`count(*) desc`);

  const attrRange = and(
    eq(schema.attributions.tenantId, tenantId),
    gte(schema.attributions.orderPlacedAt, from),
    lt(schema.attributions.orderPlacedAt, to),
  );
  const [attr] = await tx
    .select({
      orders: sql<number>`count(*) filter (where ${schema.attributions.reversedAt} is null)::int`,
      byCheckout: sql<number>`count(*) filter (where ${schema.attributions.reversedAt} is null and ${schema.attributions.matchedBy} = 'checkout')::int`,
      byPhone: sql<number>`count(*) filter (where ${schema.attributions.reversedAt} is null and ${schema.attributions.matchedBy} = 'phone')::int`,
      reversed: sql<number>`count(*) filter (where ${schema.attributions.reversedAt} is not null)::int`,
    })
    .from(schema.attributions)
    .where(attrRange);
  const revenue = await tx
    .select({
      currency: schema.attributions.currency,
      minor: sql<string>`coalesce(sum(${schema.attributions.valueMinor}), 0)`,
    })
    .from(schema.attributions)
    .where(and(attrRange, isNull(schema.attributions.reversedAt)))
    .groupBy(schema.attributions.currency);

  const [cod] = await tx
    .select({
      confirmed: sql<number>`count(*) filter (where ${schema.callOutcomes.outcome} in ('confirmed','confirmed_with_changes'))::int`,
      cancelled: sql<number>`count(*) filter (where ${schema.callOutcomes.outcome} = 'cancelled')::int`,
    })
    .from(schema.callOutcomes)
    .innerJoin(schema.callIntents, eq(schema.callIntents.id, schema.callOutcomes.intentId))
    .where(
      and(
        eq(schema.callOutcomes.tenantId, tenantId),
        eq(schema.callIntents.useCase, 'cod_confirm'),
        eq(schema.callOutcomes.superseded, false),
        gte(schema.callOutcomes.createdAt, from),
        lt(schema.callOutcomes.createdAt, to),
      ),
    );

  const charges = await tx
    .select({
      currency: schema.billingLedger.currency,
      minor: sql<string>`coalesce(sum(${schema.billingLedger.totalMinor}), 0)`,
    })
    .from(schema.billingLedger)
    .where(
      and(
        eq(schema.billingLedger.tenantId, tenantId),
        gte(schema.billingLedger.createdAt, from),
        lt(schema.billingLedger.createdAt, to),
      ),
    )
    .groupBy(schema.billingLedger.currency);

  const [tenant] = await tx
    .select({ settings: schema.tenants.settings })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  const roi = roiSettingsOf(tenant?.settings);
  const cancelledBeforeShip = cod?.cancelled ?? 0;

  return {
    from,
    to,
    checkouts: {
      total: funnel?.total ?? 0,
      withPhone: funnel?.withPhone ?? 0,
      withConsent: funnel?.withConsent ?? 0,
      scheduled: funnel?.scheduled ?? 0,
      completedByThemselves: funnel?.completed ?? 0,
      converted: funnel?.converted ?? 0,
      expired: funnel?.expired ?? 0,
      waiting: funnel?.waiting ?? 0,
      skipped,
    },
    calls: {
      intents: intents?.n ?? 0,
      dialled: calls?.dialled ?? 0,
      answered: calls?.answered ?? 0,
      outcomes,
    },
    recovered: {
      orders: attr?.orders ?? 0,
      byCheckout: attr?.byCheckout ?? 0,
      byPhone: attr?.byPhone ?? 0,
      reversed: attr?.reversed ?? 0,
      revenue: revenue.map((r) => ({ currency: r.currency, minor: Number(r.minor) })),
      windowHours: roi.attributionHours,
    },
    cod: {
      confirmed: cod?.confirmed ?? 0,
      cancelledBeforeShip,
      rtoAvoidedMinor: roi.rtoCostPaise === null ? null : roi.rtoCostPaise * cancelledBeforeShip,
      rtoCostPaise: roi.rtoCostPaise,
    },
    charges: charges.map((c) => ({ currency: c.currency, minor: Number(c.minor) })),
  };
}
