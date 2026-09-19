import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema, withTenant, type Db } from '@naaradh/db';
import {
  SubscribeInput,
  listDisputes,
  openDispute,
  razorpayPlanFor,
  recordRazorpaySubscription,
  recordStripeCheckout,
  StripeCheckoutInput,
  stripePricesFor,
  usageSummary,
  type StripeCurrency,
} from '@naaradh/pipeline';
import {
  RazorpayError,
  RazorpayRetryableError,
  StripeError,
  StripeRetryableError,
  type RazorpayClient,
  type StripeClient,
} from '@naaradh/payments';
import { NaaradhError } from '@naaradh/shared';
import { requireScope } from '../auth.js';

/**
 * Billing (P2-BILL-1…3, ADR-0008):
 *
 *   GET  /v1/billing                        plan, allowance, usage, charges this period     billing:read
 *   POST /v1/billing/razorpay/subscribe     start a Razorpay subscription (direct merchants) billing:write
 *   POST /v1/billing/stripe/checkout        start a Stripe subscription (dollar merchants)    billing:write
 *   POST /v1/outcomes/:id/disputes          dispute a billed outcome within 7 days (E-62)  billing:write
 *   GET  /v1/disputes                                                                        billing:read
 *
 * Shopify-installed merchants are billed ONLY through the Shopify Billing API (App Store rule);
 * the embedded app starts their subscription, so the Razorpay route refuses them.
 */
export interface BillingRouteDeps {
  readonly db: Db;
  readonly razorpay: RazorpayClient | null;
  /** `"<outbound plan>+<inbound plan>"` (either side may be `-`) → Razorpay plan id. */
  readonly razorpayPlanIds: Readonly<Record<string, string>>;
  /** Null when Stripe is not configured (dollar billing unavailable). P6-BILL-1. */
  readonly stripe?: StripeClient | null;
  /** Plan code → Stripe price id (USD). */
  readonly stripePriceIds?: Readonly<Record<string, string>>;
  readonly clock: () => Date;
}

export const DisputeBody = z.object({ reason: z.string().trim().min(10).max(2000) }).strict();

export function registerBillingRoutes(app: FastifyInstance, deps: BillingRouteDeps): void {
  app.get('/v1/billing', async (request) => {
    const auth = requireScope(request, 'billing:read');
    const s = await withTenant(deps.db, auth.tenantId, (tx) =>
      usageSummary(tx, auth.tenantId, deps.clock()),
    );
    return {
      period: s.period,
      currency: s.currency,
      billing_status: s.billingStatus,
      billing_provider: s.billingProvider,
      grace_until: s.graceUntil?.toISOString() ?? null,
      outbound: s.outbound,
      inbound: s.inbound,
      credits_minor: s.credits,
      postings: s.postings,
      subscription:
        s.subscription === null
          ? null
          : {
              ...s.subscription,
              current_period_end: s.subscription.currentPeriodEnd?.toISOString() ?? null,
            },
    };
  });

  app.post('/v1/billing/razorpay/subscribe', async (request, reply) => {
    const auth = requireScope(request, 'billing:write');
    const body = SubscribeInput.parse(request.body);
    const razorpay = deps.razorpay;
    if (razorpay === null)
      throw new NaaradhError('ENGINE_UNAVAILABLE', 'Razorpay billing is not configured');
    const planId = await withTenant(deps.db, auth.tenantId, (tx) =>
      razorpayPlanFor(tx, auth.tenantId, deps.razorpayPlanIds, body),
    );
    // The provider call happens outside any transaction.
    const sub = await createRazorpaySubscription(razorpay, planId, auth.tenantId, body);
    const id = await withTenant(deps.db, auth.tenantId, (tx) =>
      recordRazorpaySubscription(
        tx,
        { tenantId: auth.tenantId, type: 'api_key', id: auth.apiKeyId, requestId: request.id },
        body,
        sub,
      ),
    );
    // The merchant authorises the mandate at short_url; the webhook + re-fetch activates it.
    return reply
      .code(201)
      .send({ subscription_id: id, status: 'pending', authorize_url: sub.shortUrl });
  });

  app.post('/v1/billing/stripe/checkout', async (request, reply) => {
    const auth = requireScope(request, 'billing:write');
    const raw = StripeCheckoutInput.parse(request.body);
    const body = SubscribeInput.parse({
      plan_code: raw.plan_code,
      inbound_plan_code: raw.inbound_plan_code,
    });
    const stripe = deps.stripe ?? null;
    if (stripe === null)
      throw new NaaradhError('ENGINE_UNAVAILABLE', 'Stripe billing is not configured');
    const { prices, currency } = await withTenant(deps.db, auth.tenantId, async (tx) => {
      const [t] = await tx
        .select({ currency: schema.tenants.currency })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, auth.tenantId))
        .limit(1);
      const cur = t?.currency ?? 'USD';
      return {
        prices: await stripePricesFor(tx, auth.tenantId, deps.stripePriceIds ?? {}, body, cur),
        currency: cur as StripeCurrency,
      };
    });
    // The provider call happens outside any transaction.
    const session = await createStripeCheckout(stripe, {
      priceIds: prices,
      tenantId: auth.tenantId,
      successUrl: raw.success_url,
      cancelUrl: raw.cancel_url,
      // request.id can come from a client header; a fresh key per request is ours alone.
      idempotencyKey: `checkout:${auth.tenantId}:${randomUUID()}`,
    });
    const id = await withTenant(deps.db, auth.tenantId, (tx) =>
      recordStripeCheckout(
        tx,
        { tenantId: auth.tenantId, type: 'api_key', id: auth.apiKeyId, requestId: request.id },
        body,
        session,
        currency,
      ),
    );
    // The merchant pays at checkout_url; the webhook + re-fetch activates the subscription.
    return reply
      .code(201)
      .send({ subscription_id: id, status: 'pending', checkout_url: session.url });
  });

  app.post<{ Params: { id: string } }>('/v1/outcomes/:id/disputes', async (request, reply) => {
    const auth = requireScope(request, 'billing:write');
    const body = DisputeBody.parse(request.body);
    const id = await withTenant(deps.db, auth.tenantId, (tx) =>
      openDispute(tx, {
        tenantId: auth.tenantId,
        outcomeId: request.params.id,
        reason: body.reason,
        openedBy: `api_key:${auth.apiKeyId}`,
        actorType: 'api_key',
        at: deps.clock(),
      }),
    );
    return reply.code(201).send({ dispute_id: id, status: 'open' });
  });

  app.get('/v1/disputes', async (request) => {
    const auth = requireScope(request, 'billing:read');
    return {
      data: await withTenant(deps.db, auth.tenantId, (tx) => listDisputes(tx, auth.tenantId)),
    };
  });
}

/** Razorpay errors become client-facing NaaradhErrors (no provider internals leak). */
export async function createRazorpaySubscription(
  razorpay: RazorpayClient,
  planId: string,
  tenantId: string,
  body: SubscribeInput,
) {
  try {
    return await razorpay.createSubscription({
      planId,
      notes: {
        tenant_id: tenantId,
        plan_code: body.plan_code ?? '',
        inbound_plan_code: body.inbound_plan_code ?? '',
      },
    });
  } catch (error) {
    if (error instanceof RazorpayRetryableError)
      throw new NaaradhError('ENGINE_UNAVAILABLE', 'Razorpay is unavailable, try again shortly', {
        retryable: true,
        retryAfterSec: 30,
      });
    if (error instanceof RazorpayError)
      throw new NaaradhError('VALIDATION_FAILED', 'Razorpay refused the subscription', {
        context: { code: error.code ?? 'unknown' },
      });
    throw error;
  }
}

/** Stripe errors become client-facing NaaradhErrors (no provider internals leak). */
export async function createStripeCheckout(
  stripe: StripeClient,
  input: Parameters<StripeClient['createCheckoutSession']>[0],
) {
  try {
    return await stripe.createCheckoutSession(input);
  } catch (error) {
    if (error instanceof StripeRetryableError)
      throw new NaaradhError('ENGINE_UNAVAILABLE', 'Stripe is unavailable, try again shortly', {
        retryable: true,
        retryAfterSec: 30,
      });
    if (error instanceof StripeError)
      throw new NaaradhError('VALIDATION_FAILED', 'Stripe refused the checkout', {
        context: { code: error.code ?? 'unknown' },
      });
    throw error;
  }
}
