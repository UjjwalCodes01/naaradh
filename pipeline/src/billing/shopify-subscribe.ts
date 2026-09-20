import { eq } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import { NaaradhError, newId } from '@naaradh/shared';
import { audit } from '../audit.js';
import { auditActor, type Actor } from '../admin/actor.js';
import { PLANS, formatMinor, type BillingCurrency } from './plans.js';
import type { SubscribeInput } from './razorpay-subscribe.js';

/**
 * Shopify Billing API subscriptions started from the embedded app (P2-SHOP-3, ADR-0008).
 * `shopifySubscriptionTerms()` builds what the merchant approves in Shopify admin: one recurring
 * line (the plan fees) and one capped usage line (charges beyond the allowance, up to the cap
 * the merchant chose). The pending row recorded here carries the plan codes; the
 * `app_subscriptions/update` webhook + re-fetch (billing worker) activates it.
 */

export interface ShopifySubscriptionTerms {
  readonly name: string;
  readonly recurringMinor: number;
  readonly terms: string;
  readonly currency: BillingCurrency;
}

export function shopifySubscriptionTerms(
  input: SubscribeInput,
  currency: BillingCurrency,
): ShopifySubscriptionTerms {
  const parts: string[] = [];
  const terms: string[] = [];
  let recurring = 0;
  for (const [code, unit] of [
    [input.plan_code, 'confirmed outcome'],
    [input.inbound_plan_code, 'support-line minute'],
  ] as const) {
    if (code === null) continue;
    const plan = PLANS[code];
    if (plan === undefined) throw new NaaradhError('VALIDATION_FAILED', `unknown plan ${code}`);
    const price = plan.prices[currency];
    recurring += price.feeMinor;
    parts.push(plan.name);
    terms.push(
      `${formatMinor(price.unitMinor, currency)} per ${unit} beyond ${price.includedUnits.toLocaleString('en-IN')} a month`,
    );
  }
  if (parts.length === 0) throw new NaaradhError('VALIDATION_FAILED', 'choose at least one plan');
  return {
    name: `Naaradh ${parts.join(' + ')}`.slice(0, 255),
    recurringMinor: recurring,
    terms: terms.join('; ').slice(0, 500),
    currency,
  };
}

export async function recordShopifySubscription(
  tx: Tx,
  actor: Actor,
  input: SubscribeInput,
  provider: {
    readonly subscriptionId: string;
    readonly usageLineItemId: string | null;
    readonly currency: BillingCurrency;
    readonly recurringMinor: number;
    readonly cappedAmountMinor: number;
    readonly test: boolean;
  },
): Promise<string> {
  const id = newId('billingSubscription');
  await tx.insert(schema.billingSubscriptions).values({
    id,
    tenantId: actor.tenantId,
    provider: 'shopify',
    providerSubscriptionId: provider.subscriptionId,
    providerLineItemId: provider.usageLineItemId,
    planCode: input.plan_code,
    inboundPlanCode: input.inbound_plan_code,
    status: 'pending',
    providerStatus: 'PENDING',
    currency: provider.currency,
    recurringMinor: provider.recurringMinor,
    cappedAmountMinor: provider.cappedAmountMinor,
    test: provider.test,
  });
  await audit(tx, {
    ...auditActor(actor),
    action: 'billing.subscription_started',
    targetType: 'billing_subscription',
    targetId: id,
    after: {
      provider: 'shopify',
      plan_code: input.plan_code,
      inbound_plan_code: input.inbound_plan_code,
      capped_amount_minor: provider.cappedAmountMinor,
      test: provider.test,
    },
  });
  return id;
}

/**
 * The merchant compliance attestation (SPEC §13): the onboarding clickwrap. Stored on the tenant
 * (`settings.attestation`) with the wording version, and in the audit trail.
 */
export const ATTESTATION_VERSION = '2026-09-v1';

export const MERCHANT_ATTESTATION = [
  'We are the sender of these calls and will keep our DLT Principal Entity registration current.',
  'We have a lawful basis for every number we ask Naaradh to call, and recorded consent for any promotional call.',
  'Our scripts and knowledge articles are truthful; we will not ask customers for OTPs, card numbers, UPI PINs, Aadhaar numbers or passwords.',
  'We will cooperate with complaints and accept that calling pauses automatically after repeated complaints.',
] as const;

export async function recordAttestation(
  tx: Tx,
  actor: Actor,
  by: string,
  now: Date,
): Promise<void> {
  const [t] = await tx
    .select({ settings: schema.tenants.settings })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, actor.tenantId))
    .limit(1);
  if (t === undefined) throw new NaaradhError('NOT_FOUND', 'account not found');
  const settings = {
    ...((t.settings ?? {}) as Record<string, unknown>),
    attestation: {
      version: ATTESTATION_VERSION,
      accepted_at: now.toISOString(),
      by: by.slice(0, 120),
    },
  };
  await tx.update(schema.tenants).set({ settings }).where(eq(schema.tenants.id, actor.tenantId));
  await audit(tx, {
    ...auditActor(actor),
    action: 'tenant.attestation_accepted',
    targetType: 'tenant',
    targetId: actor.tenantId,
    after: { version: ATTESTATION_VERSION },
  });
}

export function attestationOf(settings: unknown): { version: string; acceptedAt: string } | null {
  if (settings === null || typeof settings !== 'object') return null;
  const a = (settings as Record<string, unknown>)['attestation'];
  if (a === null || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  return typeof o['version'] === 'string' && typeof o['accepted_at'] === 'string'
    ? { version: o['version'], acceptedAt: o['accepted_at'] }
    : null;
}
