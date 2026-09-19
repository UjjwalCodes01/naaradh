import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import { addDays } from '@naaradh/shared';
import { audit } from '../audit.js';
import { emitMerchantEvent } from '../outbox.js';

/**
 * Subscription state → tenant billing status (ADR-0008, E-50, E-61). Runs on the SERVICE role:
 * `tenants.billing_status` is not an app-role column. Every change here comes from a state the
 * worker FETCHED from the provider, never from a webhook body.
 */

export type SubscriptionStatus = (typeof schema.billingSubscriptionStatus.enumValues)[number];
export type TenantBillingStatus = (typeof schema.billingStatus.enumValues)[number];

/** E-50: after a payment problem, dispatch continues this long, then the gate refuses. */
export const BILLING_GRACE_DAYS = 3;

export function fromShopifyStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'ACTIVE':
    case 'ACCEPTED':
      return 'active';
    case 'FROZEN':
      return 'frozen';
    case 'CANCELLED':
      return 'cancelled';
    case 'DECLINED':
      return 'declined';
    case 'EXPIRED':
      return 'expired';
    default:
      return 'pending';
  }
}

export function fromRazorpayStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'active':
    case 'authenticated':
      return 'active';
    case 'pending':
    case 'halted':
    case 'paused':
      return 'frozen';
    case 'cancelled':
    case 'completed':
      return 'cancelled';
    case 'expired':
      return 'expired';
    default:
      return 'pending';
  }
}

/** Stripe (P6-BILL-1). past_due / unpaid keep the E-50 grace; paused is frozen. */
export function fromStripeStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'paused':
      return 'frozen';
    case 'canceled':
      return 'cancelled';
    case 'incomplete_expired':
      return 'expired';
    default:
      return 'pending';
  }
}

export interface FetchedSubscription {
  readonly status: SubscriptionStatus;
  readonly providerStatus: string;
  readonly currentPeriodEnd: Date | null;
  readonly usageLineItemId?: string | null;
  readonly cappedAmountMinor?: number | null;
  /** Shopify usage balance this interval — decides `capped` (E-61). */
  readonly balanceUsedMinor?: number | null;
}

export interface BillingTransition {
  readonly before: TenantBillingStatus;
  readonly after: TenantBillingStatus;
  readonly graceUntil: Date | null;
  readonly requeuedCapped: number;
}

/**
 * Record the fetched state of one subscription, then derive the tenant's status from ALL of its
 * subscriptions — so the CANCELLED webhook for a plan the merchant just replaced does not cancel
 * a tenant whose new plan is ACTIVE.
 */
export async function applySubscriptionState(
  tx: Tx,
  input: {
    readonly subscriptionRowId: string;
    readonly fetched: FetchedSubscription;
    readonly at: Date;
    readonly actor: string;
  },
): Promise<BillingTransition | null> {
  const { fetched, at } = input;
  const [row] = await tx
    .update(schema.billingSubscriptions)
    .set({
      status: fetched.status,
      providerStatus: fetched.providerStatus,
      currentPeriodEnd: fetched.currentPeriodEnd,
      lastFetchedAt: at,
      ...(fetched.usageLineItemId === undefined || fetched.usageLineItemId === null
        ? {}
        : { providerLineItemId: fetched.usageLineItemId }),
      ...(fetched.cappedAmountMinor === undefined
        ? {}
        : { cappedAmountMinor: fetched.cappedAmountMinor }),
      ...(fetched.status === 'active'
        ? { activatedAt: sql`coalesce(${schema.billingSubscriptions.activatedAt}, ${at})` }
        : {}),
      ...(fetched.status === 'cancelled' ||
      fetched.status === 'expired' ||
      fetched.status === 'declined'
        ? { cancelledAt: sql`coalesce(${schema.billingSubscriptions.cancelledAt}, ${at})` }
        : {}),
    })
    .where(eq(schema.billingSubscriptions.id, input.subscriptionRowId))
    .returning({
      tenantId: schema.billingSubscriptions.tenantId,
      provider: schema.billingSubscriptions.provider,
      planCode: schema.billingSubscriptions.planCode,
      inboundPlanCode: schema.billingSubscriptions.inboundPlanCode,
    });
  if (row === undefined) return null;

  // The plan the merchant approved is the plan they are metered on — set only by an ACTIVE
  // subscription the provider confirmed, never by the request that created it.
  if (fetched.status === 'active') {
    await tx
      .update(schema.tenants)
      .set({
        billingProvider: row.provider,
        ...(row.planCode === null ? {} : { planCode: row.planCode }),
        ...(row.inboundPlanCode === null ? {} : { inboundPlanCode: row.inboundPlanCode }),
      })
      .where(eq(schema.tenants.id, row.tenantId));
  }

  const [tenant] = await tx
    .select({
      billingStatus: schema.tenants.billingStatus,
      graceUntil: schema.tenants.billingGraceUntil,
    })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, row.tenantId))
    .limit(1);
  if (tenant === undefined) return null;

  const subs = await tx
    .select({
      status: schema.billingSubscriptions.status,
      activatedAt: schema.billingSubscriptions.activatedAt,
    })
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.tenantId, row.tenantId))
    .orderBy(desc(schema.billingSubscriptions.createdAt));

  const overCap =
    fetched.status === 'active' &&
    fetched.cappedAmountMinor !== undefined &&
    fetched.cappedAmountMinor !== null &&
    fetched.balanceUsedMinor !== undefined &&
    fetched.balanceUsedMinor !== null &&
    fetched.balanceUsedMinor >= fetched.cappedAmountMinor;

  let after: TenantBillingStatus;
  let graceUntil: Date | null = null;
  if (subs.some((s) => s.status === 'active')) {
    after = overCap ? 'capped' : 'active';
  } else if (subs.some((s) => s.status === 'frozen')) {
    after = 'frozen';
    graceUntil =
      tenant.billingStatus === 'frozen' && tenant.graceUntil !== null
        ? tenant.graceUntil
        : addDays(at, BILLING_GRACE_DAYS);
  } else if (subs.some((s) => s.activatedAt !== null)) {
    after = 'cancelled';
  } else {
    // Only pending/declined/expired attempts, never activated: still not set up.
    after = 'none';
  }

  let requeuedCapped = 0;
  if (
    after !== tenant.billingStatus ||
    (after === 'frozen' && tenant.graceUntil?.getTime() !== graceUntil?.getTime())
  ) {
    await tx
      .update(schema.tenants)
      .set({ billingStatus: after, billingGraceUntil: after === 'frozen' ? graceUntil : null })
      .where(eq(schema.tenants.id, row.tenantId));
    await audit(tx, {
      tenantId: row.tenantId,
      actorType: 'worker',
      actorId: input.actor,
      action: 'billing.status_changed',
      targetType: 'tenant',
      targetId: row.tenantId,
      before: { billing_status: tenant.billingStatus },
      after: {
        billing_status: after,
        grace_until: graceUntil?.toISOString() ?? null,
        provider: row.provider,
        provider_status: fetched.providerStatus,
      },
    });
    await emitMerchantEvent(tx, row.tenantId, {
      type: after === 'capped' ? 'billing.capped' : 'billing.status_changed',
      eventId: `${input.subscriptionRowId}:${after}:${at.toISOString()}`,
      at,
      data: {
        billing_status: after,
        previous: tenant.billingStatus,
        grace_until: graceUntil?.toISOString() ?? null,
      },
    });
    // Out of the cap (new interval or raised cap): the refused usage goes back in the queue.
    if (tenant.billingStatus === 'capped' && after === 'active') {
      const rows = await tx
        .update(schema.billingPostings)
        .set({ status: 'pending', nextAttemptAt: at, lastError: null })
        .where(
          and(
            eq(schema.billingPostings.tenantId, row.tenantId),
            eq(schema.billingPostings.status, 'capped'),
          ),
        )
        .returning({ id: schema.billingPostings.id });
      requeuedCapped = rows.length;
    }
  }
  return { before: tenant.billingStatus, after, graceUntil, requeuedCapped };
}

/** E-61 on the posting path: the provider refused a usage charge over the cap. */
export async function markTenantCapped(
  tx: Tx,
  tenantId: string,
  at: Date,
  actor: string,
): Promise<boolean> {
  const rows = await tx
    .update(schema.tenants)
    .set({ billingStatus: 'capped', billingGraceUntil: null })
    .where(
      and(
        eq(schema.tenants.id, tenantId),
        inArray(schema.tenants.billingStatus, ['active', 'frozen']),
      ),
    )
    .returning({ id: schema.tenants.id });
  if (rows.length === 0) return false;
  await audit(tx, {
    tenantId,
    actorType: 'worker',
    actorId: actor,
    action: 'billing.status_changed',
    targetType: 'tenant',
    targetId: tenantId,
    after: { billing_status: 'capped', reason: 'usage_over_cap' },
  });
  await emitMerchantEvent(tx, tenantId, {
    type: 'billing.capped',
    eventId: `${tenantId}:capped:${at.toISOString()}`,
    at,
    data: { billing_status: 'capped' },
  });
  return true;
}
