import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Tx } from '@naaradh/db';
import { NaaradhError, newId } from '@naaradh/shared';
import { audit } from '../audit.js';
import { auditActor, type Actor } from '../admin/actor.js';
import { PLANS } from './plans.js';
import { assertBilledDirectly, planKey, type SubscribeInput } from './razorpay-subscribe.js';

/**
 * Starting a Stripe subscription for a direct merchant outside India (P6-BILL-1, ADR-0008),
 * shared by `POST /v1/billing/stripe/checkout` and the dashboard. Three steps, the provider
 * calls OUTSIDE any transaction:
 *
 *   1. stripePricesFor()          — which Stripe prices, and may this tenant use them
 *   2. recordStripeCheckout()     — a `pending` row keyed by the Checkout Session id
 *   3. attachStripeSubscription() — when Checkout completes (webhook → re-fetch), the row takes
 *                                   the subscription and customer ids; the subscription's own
 *                                   fetched state then activates it (applySubscriptionState)
 *
 * Only currencies the plan catalogue prices can be sold: today USD. EUR and GBP wait for a
 * pricing decision (Q-30) rather than an exchange rate applied on the fly.
 */

export const STRIPE_CURRENCIES = ['USD'] as const;

const httpsUrl = z
  .string()
  .max(500)
  .url()
  .refine((u) => u.startsWith('https://'), 'must be an https URL');

/** `POST /v1/billing/stripe/checkout`: the plans, and where Stripe sends the merchant back. */
export const StripeCheckoutInput = z
  .object({
    plan_code: z
      .string()
      .refine((c) => PLANS[c]?.kind === 'outbound', 'unknown outbound plan')
      .nullable()
      .default(null),
    inbound_plan_code: z
      .string()
      .refine((c) => PLANS[c]?.kind === 'inbound', 'unknown support-line plan')
      .nullable()
      .default(null),
    success_url: httpsUrl,
    cancel_url: httpsUrl,
  })
  .strict()
  .refine((b) => b.plan_code !== null || b.inbound_plan_code !== null, 'choose at least one plan');
export type StripeCheckoutInput = z.infer<typeof StripeCheckoutInput>;
export type StripeCurrency = (typeof STRIPE_CURRENCIES)[number];

export async function stripePricesFor(
  tx: Tx,
  tenantId: string,
  priceIds: Readonly<Record<string, string>>,
  input: SubscribeInput,
  currency: string,
): Promise<string[]> {
  if (!(STRIPE_CURRENCIES as readonly string[]).includes(currency))
    throw new NaaradhError('VALIDATION_FAILED', `plans are not offered in ${currency} yet`, {
      context: { currency },
    });
  await assertBilledDirectly(tx, tenantId);
  const prices: string[] = [];
  for (const code of [input.plan_code, input.inbound_plan_code]) {
    if (code === null) continue;
    const price = priceIds[code];
    if (price === undefined)
      throw new NaaradhError('VALIDATION_FAILED', 'this plan is not offered', {
        context: { plan: code },
      });
    prices.push(price);
  }
  return prices;
}

export async function recordStripeCheckout(
  tx: Tx,
  actor: Actor,
  input: SubscribeInput,
  session: { readonly id: string; readonly status: string },
  currency: StripeCurrency,
): Promise<string> {
  const id = newId('billingSubscription');
  const fee = (code: string | null) =>
    code === null ? 0 : (PLANS[code]?.prices[currency].feeMinor ?? 0);
  await tx.insert(schema.billingSubscriptions).values({
    id,
    tenantId: actor.tenantId,
    provider: 'stripe',
    // The Checkout Session id until Checkout completes; then the subscription id.
    providerSubscriptionId: session.id,
    planCode: input.plan_code,
    inboundPlanCode: input.inbound_plan_code,
    status: 'pending',
    providerStatus: `checkout_${session.status}`,
    currency,
    recurringMinor: fee(input.plan_code) + fee(input.inbound_plan_code),
  });
  await audit(tx, {
    ...auditActor(actor),
    action: 'billing.subscription_started',
    targetType: 'billing_subscription',
    targetId: id,
    after: { provider: 'stripe', key: planKey(input), currency },
  });
  return id;
}

/**
 * Checkout completed: the pending row becomes the real subscription. Idempotent — a row that
 * already has the subscription id is returned as it is. Service role (billing worker).
 */
export async function attachStripeSubscription(
  tx: Tx,
  input: {
    readonly checkoutSessionId: string;
    readonly subscriptionId: string;
    readonly customerId: string;
  },
): Promise<string | null> {
  const [existing] = await tx
    .select({ id: schema.billingSubscriptions.id })
    .from(schema.billingSubscriptions)
    .where(
      and(
        eq(schema.billingSubscriptions.provider, 'stripe'),
        eq(schema.billingSubscriptions.providerSubscriptionId, input.subscriptionId),
      ),
    )
    .limit(1);
  if (existing !== undefined) return existing.id;
  const [row] = await tx
    .update(schema.billingSubscriptions)
    .set({
      providerSubscriptionId: input.subscriptionId,
      providerCustomerId: input.customerId,
    })
    .where(
      and(
        eq(schema.billingSubscriptions.provider, 'stripe'),
        eq(schema.billingSubscriptions.providerSubscriptionId, input.checkoutSessionId),
      ),
    )
    .returning({
      id: schema.billingSubscriptions.id,
      tenantId: schema.billingSubscriptions.tenantId,
    });
  if (row === undefined) return null;
  await audit(tx, {
    tenantId: row.tenantId,
    actorType: 'worker',
    action: 'billing.stripe_checkout_completed',
    targetType: 'billing_subscription',
    targetId: row.id,
    after: { subscription: input.subscriptionId },
  });
  return row.id;
}
