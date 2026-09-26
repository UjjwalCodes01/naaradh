/**
 * The one shape every one-click-checkout provider is mapped to.
 *
 * It is deliberately the same field set as `ParsedShopifyCheckout` (`@naaradh/shopify-sdk`), so
 * the worker that turns a cart into an abandoned-cart intent is the same code for a Shopify
 * checkout and for GoKwik, Shiprocket, Razorpay Magic or Cashfree. Everything downstream — the
 * 45-minute debounce, the 24-hour expiry, one call per cart, consent, the DND scrub — lives in
 * `@naaradh/pipeline` (`recordCheckout`, `sweepAbandonedCheckouts`) and is not repeated here.
 */

/** The providers this package knows. Each one is also an `integration_kind` and an `intent_source`. */
export const OCC_PROVIDERS = ['gokwik', 'shiprocket', 'razorpay_magic', 'cashfree'] as const;

export type OccProvider = (typeof OCC_PROVIDERS)[number];

export function isOccProvider(value: string): value is OccProvider {
  return (OCC_PROVIDERS as readonly string[]).includes(value);
}

export interface ParsedOccCheckout {
  readonly provider: OccProvider;
  /**
   * The provider's own cart identifier. One `checkouts` row per (tenant, source, ref), so this
   * must be stable across the create and update webhooks for the same cart — otherwise the same
   * abandoned cart could be called twice (E-139).
   */
  readonly externalId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Set when the provider tells us the cart turned into an order; suppresses the call. */
  readonly completedAt: Date | null;
  readonly currency: string;
  readonly totalMinor: number;
  readonly phone: string | null;
  /** ISO-3166 alpha-2 where the provider gives one; decides the recipient's calling window. */
  readonly countryCode: string | null;
  readonly firstName: string | null;
  /**
   * The value of our consent checkbox when the provider passes cart attributes through. None of
   * these providers carries it today, which is why an OCC cart is only ever called when consent
   * exists in the ledger from somewhere else (invariant 5).
   */
  readonly consentAttribute: string | null;
  readonly customerTags: readonly string[];
  readonly itemSummary: string;
  readonly itemCount: number;
  /** Always false: these providers have no draft-order or POS concept. */
  readonly isDraftOrPos: boolean;
  /** The provider's event id when it sends one, for webhook de-duplication. */
  readonly eventId: string | null;
}

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedOccCheckout }
  | { readonly ok: false; readonly error: string };
