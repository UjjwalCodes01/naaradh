/**
 * One-click-checkout providers behind one port (E-14, P5-OCC-2).
 *
 * A merchant on GoKwik, Shiprocket Checkout, Razorpay Magic or Cashfree OCC never sends Shopify
 * `checkouts/*` webhooks — the checkout is not Shopify's any more — so abandoned carts have to
 * come from the provider. This package does two things and nothing else: authenticate the
 * request (`verify.ts`) and map the body to the same shape a Shopify checkout produces
 * (`types.ts`). The cart's fate is decided by `@naaradh/pipeline` exactly as before.
 */
export {
  OCC_PROVIDERS,
  isOccProvider,
  type OccProvider,
  type ParseResult,
  type ParsedOccCheckout,
} from './types.js';

export {
  DEFAULT_SIGNATURE_POLICY,
  SIGNATURE_HEADERS,
  effectiveSignaturePolicy,
  occSharedSecret,
  occWebhookPath,
  occWebhookTag,
  verifyOccSignature,
  verifyOccTag,
  type SignatureInput,
  type SignaturePolicy,
  type SignatureVerdict,
} from './verify.js';

export { parseOccCheckout } from './parse.js';
export { decimalToMinor, itemSummaryOf } from './normalise.js';
