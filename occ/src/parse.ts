/**
 * One entry point: a verified body and the provider it came from, to a checkout or a reason it
 * could not be read. The reason is stored on the webhook event and shown in the dashboard, so it
 * has to name the field — "cart id: none of the known keys is present" is a support answer,
 * "invalid payload" is not.
 */
import { parseCashfreeCheckout } from './cashfree.js';
import { parseGenericCartWebhook } from './generic-cart.js';
import { parseRazorpayMagicCheckout } from './razorpay-magic.js';
import type { OccProvider, ParseResult } from './types.js';

export function parseOccCheckout(
  provider: OccProvider,
  raw: unknown,
  receivedAt: Date,
): ParseResult {
  switch (provider) {
    case 'cashfree':
      return parseCashfreeCheckout(raw, receivedAt);
    case 'razorpay_magic':
      return parseRazorpayMagicCheckout(raw, receivedAt);
    case 'gokwik':
    case 'shiprocket':
      return parseGenericCartWebhook(provider, raw, receivedAt);
  }
}
