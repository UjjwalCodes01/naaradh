/**
 * COD detection from Shopify `payment_gateway_names` (E-45). Indian stores route COD through
 * Shopify's manual gateway OR through a one-click-checkout provider, each with its own
 * gateway label. An unknown label is NOT COD — a wrong "yes" dials a prepaid customer to
 * confirm a payment they already made, which is both pointless and a complaint risk.
 *
 * `[VERIFY]` the provider labels against real orders during the Client A pilot; add any new
 * ones here with the order id that showed them in the PR.
 */

export type GatewayClass = 'cod' | 'prepaid' | 'unknown';

/** Normalised (lower-case, trimmed, collapsed whitespace) gateway labels that mean COD. */
const COD_LABELS: ReadonlySet<string> = new Set([
  'cash on delivery (cod)',
  'cash on delivery',
  'cod',
  'manual',
  'cash_on_delivery',
  // one-click checkout providers (E-14, E-45)
  'gokwik cod',
  'gokwik - cod',
  'gokwik_cod',
  'shiprocket cod',
  'shiprocket checkout - cod',
  'razorpay magic cod',
  'magic checkout cod',
  'cashfree cod',
  'cashfree checkout - cod',
]);

/** Labels that are definitely prepaid, so a partial match on "cod" cannot fool us. */
const PREPAID_LABELS: ReadonlySet<string> = new Set([
  'razorpay',
  'razorpay secure',
  'razorpay magic',
  'cashfree',
  'cashfree payments',
  'paytm',
  'phonepe',
  'payu',
  'shopify_payments',
  'shopify payments',
  'stripe',
  'paypal',
  'gokwik',
  'gokwik prepaid',
  'shiprocket checkout',
  'bogus',
]);

export function normaliseGateway(label: string): string {
  return label.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function classifyGateway(label: string): GatewayClass {
  const n = normaliseGateway(label);
  if (COD_LABELS.has(n)) return 'cod';
  if (PREPAID_LABELS.has(n)) return 'prepaid';
  // Provider labels drift ("GoKwik COD (Partial)"); accept a label that starts with a known
  // provider and contains a standalone "cod" token, but never a bare substring match.
  if (/\bcod\b/.test(n) && /^(gokwik|shiprocket|razorpay magic|magic checkout|cashfree)/.test(n))
    return 'cod';
  return 'unknown';
}

/**
 * An order is COD when every gateway it used is COD. Mixed (partial prepaid + COD balance)
 * is treated as COD only if at least one COD gateway is present and no prepaid one is —
 * partial-COD orders are confirmed by the merchant's own flow for now.
 */
export function isCodOrder(paymentGatewayNames: readonly string[]): {
  cod: boolean;
  classes: GatewayClass[];
  unknown: string[];
} {
  const classes = paymentGatewayNames.map(classifyGateway);
  const unknown = paymentGatewayNames.filter((_g, i) => classes[i] === 'unknown');
  const cod =
    classes.length > 0 &&
    classes.some((c) => c === 'cod') &&
    !classes.some((c) => c === 'prepaid') &&
    unknown.length === 0;
  return { cod, classes, unknown };
}

/**
 * Payment kind for the order cache (ADR-0006 cancellation policy). NOT financial_status:
 * Shopify marks a COD order `paid` once cash is collected on delivery. Mixed or unrecognised
 * gateways are `unknown`, which the agent turns into a ticket rather than a cancellation.
 */
export function paymentKindOf(
  paymentGatewayNames: readonly string[],
): 'cod' | 'prepaid' | 'unknown' {
  const { cod, classes } = isCodOrder(paymentGatewayNames);
  if (cod) return 'cod';
  if (classes.length > 0 && classes.every((c) => c === 'prepaid')) return 'prepaid';
  return 'unknown';
}
