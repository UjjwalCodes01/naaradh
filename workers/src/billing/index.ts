import { and, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { schema } from '@naaradh/db';
import {
  applySubscriptionState,
  audit,
  claimPostings,
  createPostings,
  effectivePlan,
  emitMerchantEvent,
  attachStripeSubscription,
  fromRazorpayStatus,
  fromShopifyStatus,
  fromStripeStatus,
  markTenantCapped,
  planTenantOf,
  settlePosting,
  type ClaimedPosting,
  type FetchedSubscription,
} from '@naaradh/pipeline';
import { RazorpayRetryableError, StripeRetryableError } from '@naaradh/payments';
import { ShopifyUserError, createUsageRecord, fetchSubscription } from '@naaradh/shopify-sdk';
import { addDays, addMinutes, newId } from '@naaradh/shared';
import type { EventMessage } from '../bus.js';
import type { WorkerContext } from '../context.js';
import { runLoop } from '../loop.js';
import { isRetryableWritebackError } from '../results/shopify-writeback.js';
import { shopifyClientFor } from '../shopify-client.js';
import { loadWebhookEvent, markWebhookFailed, markWebhookProcessed } from '../webhook-events.js';

/**
 * billing worker (P2-BILL-1, P2-SHOP-3, ADR-0008):
 *
 *   postings      ledger rows → billing_postings → provider (Shopify usage records, Razorpay add-ons,
 *                 Stripe invoice items)
 *   subscriptions provider webhooks are HINTS: re-fetch, then update subscription + tenant status
 *   reconcile     nightly: posted totals vs the provider's own balance; margin per tenant (E-33)
 *
 * Service role throughout — it moves money for every tenant and changes `tenants.billing_status`.
 */

const MAX_POSTING_ATTEMPTS = 8;
const GROSS_MARGIN_ALERT = 0.4;

export interface BillingReport {
  readonly created: { shopify: number; razorpay: number; stripe: number };
  readonly posted: number;
  readonly capped: number;
  readonly failed: number;
}

export async function runBillingOnce(ctx: WorkerContext, batch = 20): Promise<BillingReport> {
  const now = ctx.clock.now();
  const created = await ctx.service.transaction((tx) => createPostings(tx, now));
  const claimed = await ctx.service.transaction((tx) => claimPostings(tx, now, batch));
  const report = { created, posted: 0, capped: 0, failed: 0 };
  for (const p of claimed) {
    const r = await executePosting(ctx, p).catch((error: unknown) => {
      ctx.log.error({ err: error, posting_id: p.id }, 'billing posting crashed');
      return 'failed' as const;
    });
    report[r] += 1;
  }
  return report;
}

async function executePosting(
  ctx: WorkerContext,
  p: ClaimedPosting,
): Promise<'posted' | 'capped' | 'failed'> {
  const now = ctx.clock.now();
  const load = (where: SQL | undefined) =>
    ctx.service
      .select({
        id: schema.billingSubscriptions.id,
        providerSubscriptionId: schema.billingSubscriptions.providerSubscriptionId,
        lineItemId: schema.billingSubscriptions.providerLineItemId,
        customerId: schema.billingSubscriptions.providerCustomerId,
        status: schema.billingSubscriptions.status,
      })
      .from(schema.billingSubscriptions)
      .where(where)
      .orderBy(desc(schema.billingSubscriptions.createdAt))
      .limit(1);
  let [sub] =
    p.subscriptionId === null
      ? []
      : await load(eq(schema.billingSubscriptions.id, p.subscriptionId));
  if (sub === undefined || sub.status !== 'active') {
    // The merchant changed plan: charge the subscription that is active now, if there is one.
    [sub] = await load(
      and(
        eq(schema.billingSubscriptions.tenantId, p.tenantId),
        eq(schema.billingSubscriptions.provider, p.provider),
        eq(schema.billingSubscriptions.status, 'active'),
      ),
    );
    if (sub === undefined) {
      await ctx.service.transaction((tx) =>
        settlePosting(tx, p.id, {
          status: 'failed',
          error: 'no_active_subscription',
          retryAt: addMinutes(now, 60),
        }),
      );
      return 'failed';
    }
    await ctx.service
      .update(schema.billingPostings)
      .set({ subscriptionId: sub.id })
      .where(eq(schema.billingPostings.id, p.id));
  }

  try {
    let providerRef: string;
    if (p.provider === 'shopify') {
      if (sub.lineItemId === null) throw new Error('subscription has no usage line item');
      const store = await shopifyClientFor(ctx, p.tenantId);
      if (store === null) throw new Error('no active Shopify integration');
      try {
        providerRef = await createUsageRecord(store.client, {
          lineItemId: sub.lineItemId,
          price: { minor: p.amountMinor, currency: p.currency },
          description: p.description,
          idempotencyKey: p.idempotencyKey,
        });
      } catch (error) {
        if (!(error instanceof ShopifyUserError)) throw error;
        // Refused: is it the cap (E-61)? Ask Shopify rather than parse the message.
        const fetched = await fetchSubscription(store.client, sub.providerSubscriptionId);
        const over =
          fetched !== null &&
          fetched.cappedAmount !== null &&
          (fetched.balanceUsed?.minor ?? 0) + p.amountMinor > fetched.cappedAmount.minor;
        if (over) {
          await ctx.service.transaction(async (tx) => {
            await settlePosting(tx, p.id, { status: 'capped', error: error.message });
            await markTenantCapped(tx, p.tenantId, now, ctx.workerId);
          });
          ctx.log.warn(
            { tenant_id: p.tenantId, posting_id: p.id },
            'usage over capped amount — tenant capped (E-61)',
          );
          return 'capped';
        }
        throw error;
      }
    } else if (p.provider === 'stripe') {
      if (ctx.stripe === null) throw new Error('Stripe is not configured');
      if (sub.customerId === null) throw new Error('stripe subscription has no customer yet');
      const item = await ctx.stripe.createInvoiceItem({
        customerId: sub.customerId,
        subscriptionId: sub.providerSubscriptionId,
        amountMinor: p.amountMinor,
        currency: p.currency,
        description: p.description,
        // Stripe keeps idempotency keys for 24 hours; the posting's own key is stable forever,
        // and a posting is only retried while it is failed, so a second charge cannot happen.
        idempotencyKey: p.idempotencyKey,
      });
      providerRef = item.id;
    } else {
      if (ctx.razorpay === null) throw new Error('Razorpay is not configured');
      const addon = await ctx.razorpay.createAddon(sub.providerSubscriptionId, {
        name: 'Naaradh usage',
        amountMinor: p.amountMinor,
        currency: 'INR',
        description: p.description,
      });
      providerRef = addon.id;
    }
    await ctx.service.transaction(async (tx) => {
      await settlePosting(tx, p.id, { status: 'posted', providerRef, at: now });
      await audit(tx, {
        tenantId: p.tenantId,
        actorType: 'worker',
        actorId: ctx.workerId,
        action: 'billing.posted',
        targetType: 'billing_posting',
        targetId: p.id,
        after: {
          provider: p.provider,
          amount_minor: p.amountMinor,
          currency: p.currency,
          provider_ref: providerRef,
        },
      });
    });
    return 'posted';
  } catch (error) {
    const message = (
      error instanceof Error ? `${error.name}: ${error.message}` : 'non-Error thrown'
    ).slice(0, 500);
    const retryable =
      (error instanceof RazorpayRetryableError ||
        error instanceof StripeRetryableError ||
        (p.provider === 'shopify' && isRetryableWritebackError(error))) &&
      p.attempts < MAX_POSTING_ATTEMPTS;
    await ctx.service.transaction((tx) =>
      settlePosting(tx, p.id, {
        status: 'failed',
        error: message,
        retryAt: retryable ? addMinutes(now, Math.min(60, 2 ** p.attempts)) : null,
      }),
    );
    if (!retryable)
      ctx.log.error(
        { posting_id: p.id, tenant_id: p.tenantId, error: message },
        'billing posting failed — runbook billing-postings.md',
      );
    return 'failed';
  }
}

// ---- subscription state ------------------------------------------------------------------------

/** Shopify `app_subscriptions/update` (a hint): fetch the subscription and apply what Shopify says. */
export async function syncShopifySubscription(
  ctx: WorkerContext,
  tenantId: string,
  subscriptionGid: string,
): Promise<string> {
  const store = await shopifyClientFor(ctx, tenantId);
  if (store === null) return 'no_store';
  const fetched = await fetchSubscription(store.client, subscriptionGid);
  if (fetched === null) return 'not_found';
  const now = ctx.clock.now();
  return ctx.service.transaction(async (tx) => {
    let [row] = await tx
      .select({
        id: schema.billingSubscriptions.id,
        tenantId: schema.billingSubscriptions.tenantId,
      })
      .from(schema.billingSubscriptions)
      .where(
        and(
          eq(schema.billingSubscriptions.provider, 'shopify'),
          eq(schema.billingSubscriptions.providerSubscriptionId, fetched.id),
        ),
      )
      .limit(1);
    if (row !== undefined && row.tenantId !== tenantId) return 'tenant_mismatch';
    if (row === undefined) {
      // Created outside our flow (Partner Dashboard, a previous install): adopt it.
      const id = newId('billingSubscription');
      await tx.insert(schema.billingSubscriptions).values({
        id,
        tenantId,
        provider: 'shopify',
        providerSubscriptionId: fetched.id,
        providerLineItemId: fetched.usageLineItemId,
        currency: fetched.recurring?.currency ?? fetched.cappedAmount?.currency ?? 'USD',
        recurringMinor: fetched.recurring?.minor ?? 0,
        cappedAmountMinor: fetched.cappedAmount?.minor ?? null,
        test: fetched.test,
      });
      row = { id, tenantId };
    }
    const state: FetchedSubscription = {
      status: fromShopifyStatus(fetched.status),
      providerStatus: fetched.status,
      currentPeriodEnd: fetched.currentPeriodEnd,
      usageLineItemId: fetched.usageLineItemId,
      cappedAmountMinor: fetched.cappedAmount?.minor ?? null,
      balanceUsedMinor: fetched.balanceUsed?.minor ?? null,
    };
    const t = await applySubscriptionState(tx, {
      subscriptionRowId: row.id,
      fetched: state,
      at: now,
      actor: ctx.workerId,
    });
    // Shopify refuses usage charges past the cap, so billable outcomes stop being billed while
    // the calls keep going out. One structured line per transition, which is what the
    // billing_capped alert watches (P2-OPS-2, infra/modules/monitoring).
    if (t?.after === 'capped')
      ctx.log.warn(
        { tenant_id: tenantId, subscription: fetched.id },
        'shopify subscription capped amount reached',
      );
    return `shopify:${fetched.status}:${t?.after ?? '-'}`;
  });
}

/** Shopify `app_subscriptions/approaching_capped_amount`: tell the merchant before the gate stops. */
export async function notifyApproachingCap(
  ctx: WorkerContext,
  tenantId: string,
  subscriptionGid: string,
): Promise<string> {
  const now = ctx.clock.now();
  await ctx.service.transaction((tx) =>
    emitMerchantEvent(tx, tenantId, {
      type: 'billing.approaching_cap',
      eventId: `${subscriptionGid}:approaching:${now.toISOString().slice(0, 10)}`,
      at: now,
      data: { subscription: subscriptionGid },
    }),
  );
  // Watched by the billing_capped alert: the merchant has days, not hours, to raise the cap.
  ctx.log.warn(
    { tenant_id: tenantId, subscription: subscriptionGid },
    'shopify subscription approaching capped amount',
  );
  return 'approaching_cap_notified';
}

/** billing.events (Razorpay and Stripe webhooks, verified by hooks): re-fetch and apply. */
export async function handleBillingEvent(ctx: WorkerContext, message: EventMessage): Promise<void> {
  const event = await loadWebhookEvent(ctx.service, message.webhook_event_id);
  if (event === null || event.status === 'processed') return;
  if (event.source === 'stripe') return handleStripeEvent(ctx, event);
  try {
    const payload = event.payload as { subscription_id?: unknown } | null;
    const subId = typeof payload?.subscription_id === 'string' ? payload.subscription_id : null;
    if (subId === null || ctx.razorpay === null) {
      await markWebhookProcessed(
        ctx.service,
        event.id,
        subId === null ? 'not_a_subscription_event' : 'razorpay_not_configured',
      );
      return;
    }
    const [row] = await ctx.service
      .select({ id: schema.billingSubscriptions.id })
      .from(schema.billingSubscriptions)
      .where(
        and(
          eq(schema.billingSubscriptions.provider, 'razorpay'),
          eq(schema.billingSubscriptions.providerSubscriptionId, subId),
        ),
      )
      .limit(1);
    if (row === undefined) {
      await markWebhookProcessed(ctx.service, event.id, 'unknown_subscription');
      return;
    }
    const fetched = await ctx.razorpay.fetchSubscription(subId);
    const now = ctx.clock.now();
    const t = await ctx.service.transaction((tx) =>
      applySubscriptionState(tx, {
        subscriptionRowId: row.id,
        fetched: {
          status: fromRazorpayStatus(fetched.status),
          providerStatus: fetched.status,
          currentPeriodEnd: fetched.currentEnd,
        },
        at: now,
        actor: ctx.workerId,
      }),
    );
    await markWebhookProcessed(
      ctx.service,
      event.id,
      `razorpay:${fetched.status}:${t?.after ?? '-'}`,
    );
  } catch (error) {
    await markWebhookFailed(
      ctx.service,
      event.id,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

/**
 * Stripe (P6-BILL-1). The webhook says only WHICH object changed; the state comes from Stripe:
 *
 *   checkout.session.completed  → fetch the session; the pending row takes the subscription and
 *                                 customer ids; then the subscription's state is applied
 *   customer.subscription.*,    → fetch the subscription and apply it (activation, past_due →
 *   invoice.*                     frozen with the E-50 grace, cancellation)
 */
async function handleStripeEvent(
  ctx: WorkerContext,
  event: NonNullable<Awaited<ReturnType<typeof loadWebhookEvent>>>,
): Promise<void> {
  try {
    const payload = event.payload as {
      subscription_id?: unknown;
      checkout_session_id?: unknown;
    } | null;
    const sessionId =
      typeof payload?.checkout_session_id === 'string' ? payload.checkout_session_id : null;
    let subId = typeof payload?.subscription_id === 'string' ? payload.subscription_id : null;
    if (ctx.stripe === null || (sessionId === null && subId === null)) {
      await markWebhookProcessed(
        ctx.service,
        event.id,
        ctx.stripe === null ? 'stripe_not_configured' : 'not_a_subscription_event',
      );
      return;
    }
    if (sessionId !== null) {
      const session = await ctx.stripe.retrieveCheckoutSession(sessionId);
      if (
        session.status !== 'complete' ||
        session.subscriptionId === null ||
        session.customerId === null
      ) {
        await markWebhookProcessed(ctx.service, event.id, `stripe:checkout_${session.status}`);
        return;
      }
      const attached = await ctx.service.transaction((tx) =>
        attachStripeSubscription(tx, {
          checkoutSessionId: sessionId,
          subscriptionId: session.subscriptionId ?? '',
          customerId: session.customerId ?? '',
        }),
      );
      if (attached === null) {
        await markWebhookProcessed(ctx.service, event.id, 'unknown_checkout_session');
        return;
      }
      subId = session.subscriptionId;
    }
    const [row] = await ctx.service
      .select({ id: schema.billingSubscriptions.id })
      .from(schema.billingSubscriptions)
      .where(
        and(
          eq(schema.billingSubscriptions.provider, 'stripe'),
          eq(schema.billingSubscriptions.providerSubscriptionId, subId ?? ''),
        ),
      )
      .limit(1);
    if (row === undefined) {
      await markWebhookProcessed(ctx.service, event.id, 'unknown_subscription');
      return;
    }
    const fetched = await ctx.stripe.retrieveSubscription(subId ?? '');
    const now = ctx.clock.now();
    const t = await ctx.service.transaction((tx) =>
      applySubscriptionState(tx, {
        subscriptionRowId: row.id,
        fetched: {
          status: fromStripeStatus(fetched.status),
          providerStatus: fetched.status,
          currentPeriodEnd: fetched.currentPeriodEnd,
        },
        at: now,
        actor: ctx.workerId,
      }),
    );
    await markWebhookProcessed(
      ctx.service,
      event.id,
      `stripe:${fetched.status}:${t?.after ?? '-'}`,
    );
  } catch (error) {
    await markWebhookFailed(
      ctx.service,
      event.id,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

// ---- nightly reconciliation (P2-BILL-1, E-33) ----------------------------------------------------

export interface ReconciliationReport {
  readonly shopifyChecked: number;
  readonly mismatches: number;
  readonly lowMargin: number;
}

export async function runReconciliationOnce(ctx: WorkerContext): Promise<ReconciliationReport> {
  const now = ctx.clock.now();
  const report = { shopifyChecked: 0, mismatches: 0, lowMargin: 0 };

  // 1. What we posted in the current Shopify interval vs Shopify's own usage balance.
  const subs = await ctx.service
    .select({
      id: schema.billingSubscriptions.id,
      tenantId: schema.billingSubscriptions.tenantId,
      gid: schema.billingSubscriptions.providerSubscriptionId,
    })
    .from(schema.billingSubscriptions)
    .where(
      and(
        eq(schema.billingSubscriptions.provider, 'shopify'),
        eq(schema.billingSubscriptions.status, 'active'),
      ),
    );
  for (const s of subs) {
    const store = await shopifyClientFor(ctx, s.tenantId).catch(() => null);
    if (store === null) continue;
    const fetched = await fetchSubscription(store.client, s.gid).catch(() => null);
    if (fetched === null || fetched.balanceUsed === null || fetched.currentPeriodEnd === null)
      continue;
    report.shopifyChecked += 1;
    const intervalStart = addDays(fetched.currentPeriodEnd, -30);
    const [posted] = await ctx.service
      .select({ n: sql<string>`coalesce(sum(${schema.billingPostings.amountMinor}), 0)` })
      .from(schema.billingPostings)
      .where(
        and(
          eq(schema.billingPostings.subscriptionId, s.id),
          eq(schema.billingPostings.status, 'posted'),
          gt(schema.billingPostings.postedAt, intervalStart),
        ),
      );
    const ours = Number(posted?.n ?? 0);
    if (ours !== fetched.balanceUsed.minor) {
      report.mismatches += 1;
      ctx.log.warn(
        {
          tenant_id: s.tenantId,
          subscription: s.gid,
          posted_minor: ours,
          shopify_balance_minor: fetched.balanceUsed.minor,
        },
        'billing reconciliation delta (must be 0) — runbook billing-postings.md',
      );
    }
    // Keep our copy of the subscription fresh.
    await ctx.service.transaction((tx) =>
      applySubscriptionState(tx, {
        subscriptionRowId: s.id,
        fetched: {
          status: fromShopifyStatus(fetched.status),
          providerStatus: fetched.status,
          currentPeriodEnd: fetched.currentPeriodEnd,
          usageLineItemId: fetched.usageLineItemId,
          cappedAmountMinor: fetched.cappedAmount?.minor ?? null,
          balanceUsedMinor: fetched.balanceUsed?.minor ?? null,
        },
        at: now,
        actor: ctx.workerId,
      }),
    );
  }

  // 2. Gross margin per tenant over the last day (E-33): usage billed + a day of fee vs vendor cost.
  const since = addDays(now, -1);
  const rows = await ctx.service
    .select({
      tenantId: schema.billingLedger.tenantId,
      revenue: sql<string>`coalesce(sum(${schema.billingLedger.totalMinor}), 0)`,
      cost: sql<string>`coalesce(sum(case when ${schema.billingLedger.vendorCostCurrency} = ${schema.billingLedger.currency} then ${schema.billingLedger.vendorCostMinor} else 0 end), 0)`,
    })
    .from(schema.billingLedger)
    .where(
      and(
        inArray(schema.billingLedger.kind, ['outcome', 'minute']),
        gt(schema.billingLedger.createdAt, since),
      ),
    )
    .groupBy(schema.billingLedger.tenantId);
  for (const r of rows) {
    const cost = Number(r.cost);
    if (cost === 0) continue;
    const [tenant] = await ctx.service
      .select({
        planCode: schema.tenants.planCode,
        inboundPlanCode: schema.tenants.inboundPlanCode,
        billingOverrides: schema.tenants.billingOverrides,
        currency: schema.tenants.currency,
      })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, r.tenantId))
      .limit(1);
    if (tenant === undefined) continue;
    const t = planTenantOf(tenant);
    const dailyFee = Math.round(
      (effectivePlan('outbound', t).feeMinor + effectivePlan('inbound', t).feeMinor) / 30,
    );
    const revenue = Number(r.revenue) + dailyFee;
    const margin = revenue <= 0 ? -1 : 1 - cost / revenue;
    if (margin < GROSS_MARGIN_ALERT) {
      report.lowMargin += 1;
      ctx.log.warn(
        {
          tenant_id: r.tenantId,
          revenue_minor: revenue,
          vendor_cost_minor: cost,
          gross_margin: Number(margin.toFixed(3)),
        },
        'gross margin below 40% (E-33)',
      );
    }
  }
  return report;
}

export async function runBilling(
  ctx: WorkerContext,
  pollMs: number,
  signal: AbortSignal,
): Promise<void> {
  let lastReconcile = '';
  await runLoop({
    name: 'billing',
    log: ctx.log,
    intervalMs: pollMs,
    signal,
    async tick() {
      const r = await runBillingOnce(ctx);
      if (
        r.created.shopify + r.created.razorpay + r.created.stripe + r.posted + r.capped + r.failed >
        0
      )
        ctx.log.info(r, 'billing pass');
      // Once a day, after 02:00 IST (20:30 UTC), when merchants are asleep.
      const now = ctx.clock.now();
      const day = now.toISOString().slice(0, 10);
      if (day !== lastReconcile && now.getUTCHours() * 60 + now.getUTCMinutes() >= 20 * 60 + 30) {
        lastReconcile = day;
        ctx.log.info(await runReconciliationOnce(ctx), 'billing reconciliation');
      }
    },
  });
}
