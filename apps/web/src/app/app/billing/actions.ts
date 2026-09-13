'use server';

import { RazorpayError, RazorpayRetryableError, createRazorpayClient } from '@naaradh/payments';
import { SubscribeInput, razorpayPlanFor, recordRazorpaySubscription } from '@naaradh/pipeline';
import { field, run, type ActionResult } from '@/lib/actions';
import { env } from '@/lib/env';
import { actorOf, inTenant, requireSession } from '@/lib/session';

/** Direct (non-Shopify) merchants subscribe through Razorpay; Shopify stores are refused (App Store rule). */
export async function subscribeRazorpay(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('owner');
    const e = env();
    if (e.RAZORPAY_KEY_ID === undefined || e.RAZORPAY_KEY_SECRET === undefined)
      return {
        ok: false,
        message: 'Online subscription is not available yet — write to billing@naaradh.com.',
      };
    const input = SubscribeInput.parse({
      plan_code: field(form, 'plan_code') || null,
      inbound_plan_code: field(form, 'inbound_plan_code') || null,
    });
    const planId = await inTenant(s, (tx) =>
      razorpayPlanFor(tx, s.tenantId, e.RAZORPAY_PLAN_IDS, input),
    );
    let sub;
    try {
      sub = await createRazorpayClient({
        keyId: e.RAZORPAY_KEY_ID,
        keySecret: e.RAZORPAY_KEY_SECRET,
      }).createSubscription({
        planId,
        notes: {
          tenant_id: s.tenantId,
          plan_code: input.plan_code ?? '',
          inbound_plan_code: input.inbound_plan_code ?? '',
        },
      });
    } catch (error) {
      if (error instanceof RazorpayRetryableError)
        return { ok: false, message: 'Razorpay is unavailable. Try again in a minute.' };
      if (error instanceof RazorpayError)
        return {
          ok: false,
          message: 'Razorpay refused the subscription. Contact billing@naaradh.com.',
        };
      throw error;
    }
    await inTenant(s, (tx) => recordRazorpaySubscription(tx, actorOf(s), input, sub));
    return {
      ok: true,
      message:
        'Subscription created. Authorise the payment mandate at the link below; the plan starts once Razorpay confirms it.',
      ...(sub.shortUrl === null ? {} : { secret: sub.shortUrl }),
    };
  });
}
