/**
 * Admin API access scopes the Naaradh app requests (SPEC §8.2, AGENTS §7). Minimised: every
 * scope has a code path that uses it today. Adding one needs an ADR, this file,
 * `shopify/shopify.app.toml` and docs/shopify/pcd-justification.md — in the same PR.
 *
 * Not requested (yet): `write_customers`. SPEC §8.2 lists it for syncing a verbal opt-out to
 * Shopify marketing consent, but that sync is off by default and undecided (Q-07); no code writes
 * a customer. Requesting an unused scope fails App Store review's minimisation check.
 */
export const SHOPIFY_SCOPES = [
  {
    scope: 'read_orders',
    why: 'COD order events, order status and payment gateway; the order cache the support agent answers from.',
  },
  {
    scope: 'write_orders',
    why: 'Tags, a note and metafields with the call outcome; cancelling an order only when the merchant enabled it and the customer confirmed (invariant 14).',
  },
  {
    scope: 'read_customers',
    why: 'Customer phone and name on the order (protected customer data, Level 2) to place the call the merchant enabled.',
  },
  {
    scope: 'read_checkouts',
    why: 'Abandoned-checkout calls, only with recorded consent (promotional).',
  },
  {
    scope: 'read_fulfillments',
    why: 'Delivery status for “where is my order” answers and to stop confirmation calls for shipped orders.',
  },
  { scope: 'read_locales', why: 'The store language, to default the call language.' },
] as const;

export const SHOPIFY_SCOPE_STRING = SHOPIFY_SCOPES.map((s) => s.scope).join(',');
