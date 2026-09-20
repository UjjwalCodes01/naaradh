import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { Form, useActionData, useLoaderData } from 'react-router';
import {
  PLANS,
  SubscribeInput,
  formatMinor,
  recordShopifySubscription,
  shopifySubscriptionTerms,
  usageSummary,
  type BillingCurrency,
} from '@naaradh/pipeline';
import {
  billingCurrency,
  cancelSubscription,
  createAdminClient,
  createSubscription,
} from '@naaradh/shopify-sdk';
import { errorMessage, formValue, shopContext } from '../lib/context.server';
import { billingTest, env } from '../lib/env.server';

/**
 * Shopify Billing API (P2-SHOP-3, ADR-0008): a recurring line for the plan fees and a capped
 * usage line for charges beyond the allowance. The merchant approves in Shopify admin; the
 * app_subscriptions/update webhook (hooks → billing worker, re-fetched) activates the plan.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await shopContext(request);
  const usage = await ctx.inTenant((tx) => usageSummary(tx, ctx.tenantId, new Date()));
  const c = usage.currency;
  // Plan labels are built here: route components must not import server packages.
  const label = (code: string) => {
    const p = PLANS[code];
    return p === undefined
      ? null
      : {
          value: code,
          label: `${p.name} — ${formatMinor(p.prices[c].feeMinor, c)}/30 days, ${String(p.prices[c].includedUnits)} included, then ${formatMinor(p.prices[c].unitMinor, c)} each`,
        };
  };
  const options = (codes: string[]) =>
    codes.map(label).filter((o): o is { value: string; label: string } => o !== null);
  return {
    usage: {
      currency: c,
      outbound: {
        used: usage.outbound.used,
        included: usage.outbound.included,
        extra: formatMinor(usage.outbound.extraAmountMinor, c),
      },
      inbound: {
        used: usage.inbound.used,
        included: usage.inbound.included,
        extra: formatMinor(usage.inbound.extraAmountMinor, c),
      },
      subscription:
        usage.subscription === null
          ? null
          : {
              provider: usage.subscription.provider,
              status: usage.subscription.status,
              cap:
                usage.subscription.cappedAmountMinor === null
                  ? '—'
                  : formatMinor(usage.subscription.cappedAmountMinor, c),
            },
    },
    outboundPlans: options(['starter', 'growth', 'scale']),
    inboundPlans: options(['inbound_starter', 'inbound_growth', 'inbound_scale']),
    test: billingTest(),
  };
};

function adminClient(shop: string, accessToken: string | undefined) {
  if (accessToken === undefined) throw new Response('Store not connected', { status: 401 });
  return createAdminClient({ shop, accessToken, apiVersion: env().SHOPIFY_ADMIN_API_VERSION });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await shopContext(request);
  const form = await request.formData();
  try {
    const client = adminClient(ctx.session.shop, ctx.session.accessToken);
    if (formValue(form, 'intent') === 'cancel') {
      const usage = await ctx.inTenant((tx) => usageSummary(tx, ctx.tenantId, new Date()));
      const gid = formValue(form, 'subscription_id');
      if (usage.subscription?.provider !== 'shopify' || gid === '')
        return { ok: false, message: 'No Shopify plan to cancel.' };
      await cancelSubscription(client, gid);
      return { ok: true, message: 'Cancelled. Calls stop when Shopify confirms the cancellation.' };
    }
    const input = SubscribeInput.parse({
      plan_code: formValue(form, 'plan_code') || null,
      inbound_plan_code: formValue(form, 'inbound_plan_code') || null,
    });
    const currency: BillingCurrency = (await billingCurrency(client)) === 'INR' ? 'INR' : 'USD';
    const terms = shopifySubscriptionTerms(input, currency);
    const cap = Math.round(Number(formValue(form, 'cap')) * 100);
    if (!Number.isSafeInteger(cap) || cap < 100)
      return { ok: false, message: 'Set a monthly usage cap.' };
    const created = await createSubscription(client, {
      name: terms.name,
      returnUrl: `https://${ctx.session.shop}/admin/apps/${env().SHOPIFY_API_KEY}/app/billing`,
      recurring: { minor: terms.recurringMinor, currency },
      cappedAmount: { minor: cap, currency },
      terms: terms.terms,
      test: billingTest(),
    });
    await ctx.inTenant((tx) =>
      recordShopifySubscription(tx, ctx.actor, input, {
        subscriptionId: created.subscriptionId,
        usageLineItemId: created.usageLineItemId,
        currency,
        recurringMinor: terms.recurringMinor,
        cappedAmountMinor: cap,
        test: billingTest(),
      }),
    );
    // The approval page lives in Shopify admin, outside the app iframe.
    return ctx.redirect(created.confirmationUrl, { target: '_top' });
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
};

export default function Billing() {
  const { usage: u, outboundPlans, inboundPlans, test } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const c = u.currency;
  return (
    <s-page heading="Plan & billing">
      {result === undefined ? null : (
        <s-banner tone={result.ok ? 'success' : 'critical'}>{result.message}</s-banner>
      )}
      {test ? (
        <s-banner tone="info">
          Test charges: this environment creates Shopify test subscriptions.
        </s-banner>
      ) : null}
      <s-section heading="This period">
        <s-paragraph>
          Order calls: {u.outbound.used} of {u.outbound.included} included outcomes · extra{' '}
          {u.outbound.extra}
        </s-paragraph>
        <s-paragraph>
          Support line: {u.inbound.used} of {u.inbound.included} included minutes · extra{' '}
          {u.inbound.extra}
        </s-paragraph>
        <s-paragraph>
          Only definitive answers from a person are billed (confirmed, confirmed with changes,
          cancelled, rescheduled, booked). No answer, voicemail, wrong number or opt-out is never
          billed.
        </s-paragraph>
      </s-section>
      {u.subscription !== null && u.subscription.status === 'active' ? (
        <s-section heading="Your plan">
          <s-paragraph>
            Active with {u.subscription.provider} · usage cap {u.subscription.cap} per 30 days
          </s-paragraph>
        </s-section>
      ) : (
        <Form method="post">
          <input type="hidden" name="intent" value="subscribe" />
          <s-section heading="Choose a plan">
            <s-select name="plan_code" label="COD confirmation" value="growth">
              <s-option value="">None</s-option>
              {outboundPlans.map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </s-select>
            <s-select name="inbound_plan_code" label="Support line" value="">
              <s-option value="">None</s-option>
              {inboundPlans.map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </s-select>
            <s-number-field
              name="cap"
              label={`Monthly usage cap (${c})`}
              value={c === 'INR' ? '5000' : '60'}
              details="The most extra usage Shopify will charge in 30 days. Calls pause at the cap; you can raise it any time."
            ></s-number-field>
            <s-button type="submit" variant="primary">
              Approve in Shopify
            </s-button>
          </s-section>
        </Form>
      )}
    </s-page>
  );
}
