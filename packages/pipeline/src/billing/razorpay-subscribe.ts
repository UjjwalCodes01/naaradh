import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Tx } from '@naaradh/db';
import { NaaradhError, newId } from '@naaradh/shared';
import { audit } from '../audit.js';
import { auditActor, type Actor } from '../admin/actor.js';
import { PLANS } from './plans.js';

/**
 * Starting a Razorpay subscription for a direct (non-Shopify) Indian merchant, shared by
 * `POST /v1/billing/razorpay/subscribe` and the dashboard (P2-BILL-3, ADR-0008). Two steps
 * around the provider call, which happens OUTSIDE any transaction:
 *
 *   1. razorpayPlanFor()           — which Razorpay plan, and is this tenant allowed to use it
 *   2. recordRazorpaySubscription() — a `pending` row; the webhook + re-fetch activates it
 *
 * Shopify-installed merchants are billed only through Shopify (App Store rule).
 */

export const SubscribeInput = z
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
  })
  .strict()
  .refine((b) => b.plan_code !== null || b.inbound_plan_code !== null, 'choose at least one plan');
export type SubscribeInput = z.infer<typeof SubscribeInput>;

export function planKey(input: SubscribeInput): string {
  return `${input.plan_code ?? '-'}+${input.inbound_plan_code ?? '-'}`;
}

export async function razorpayPlanFor(
  tx: Tx,
  tenantId: string,
  planIds: Readonly<Record<string, string>>,
  input: SubscribeInput,
): Promise<string> {
  const key = planKey(input);
  const planId = planIds[key];
  if (planId === undefined)
    throw new NaaradhError('VALIDATION_FAILED', 'this plan combination is not offered', {
      context: { key },
    });
  const shopify = await tx
    .select({ id: schema.integrations.id })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.tenantId, tenantId),
        eq(schema.integrations.kind, 'shopify'),
        eq(schema.integrations.status, 'active'),
      ),
    )
    .limit(1);
  if (shopify.length > 0)
    throw new NaaradhError(
      'FORBIDDEN',
      'this store is billed through Shopify — use the Naaradh app in Shopify admin',
    );
  return planId;
}

export async function recordRazorpaySubscription(
  tx: Tx,
  actor: Actor,
  input: SubscribeInput,
  provider: { readonly id: string; readonly status: string },
): Promise<string> {
  const id = newId('billingSubscription');
  const fee = (code: string | null) =>
    code === null ? 0 : (PLANS[code]?.prices.INR.feeMinor ?? 0);
  await tx.insert(schema.billingSubscriptions).values({
    id,
    tenantId: actor.tenantId,
    provider: 'razorpay',
    providerSubscriptionId: provider.id,
    planCode: input.plan_code,
    inboundPlanCode: input.inbound_plan_code,
    status: 'pending',
    providerStatus: provider.status,
    currency: 'INR',
    recurringMinor: fee(input.plan_code) + fee(input.inbound_plan_code),
  });
  await audit(tx, {
    ...auditActor(actor),
    action: 'billing.subscription_started',
    targetType: 'billing_subscription',
    targetId: id,
    after: { provider: 'razorpay', key: planKey(input) },
  });
  return id;
}

export async function listDisputes(tx: Tx, tenantId: string) {
  return tx
    .select({
      id: schema.outcomeDisputes.id,
      outcome_id: schema.outcomeDisputes.outcomeId,
      status: schema.outcomeDisputes.status,
      reason: schema.outcomeDisputes.reason,
      resolution: schema.outcomeDisputes.resolution,
      opened_at: schema.outcomeDisputes.openedAt,
      resolved_at: schema.outcomeDisputes.resolvedAt,
    })
    .from(schema.outcomeDisputes)
    .where(eq(schema.outcomeDisputes.tenantId, tenantId))
    .orderBy(desc(schema.outcomeDisputes.openedAt))
    .limit(200);
}
