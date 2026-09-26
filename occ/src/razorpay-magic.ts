/**
 * Razorpay Magic Checkout — abandoned cart webhook.
 *
 * Shape from Razorpay's published reference (razorpay.com/docs/payments/magic-checkout/
 * abandoned-cart/, read Sep 2026): a flat body with `shop_id`, `platform`, `token`,
 * `cart_token`, `email`, `phone`, `abandoned_checkout_url`, `currency`, `line_items[]`,
 * `line_items_total`, `promotions`, `tax_details` and a `customer` object with
 * `shipping_address`.
 *
 * Razorpay documents **no signature** for this webhook (unlike its payment webhooks, which send
 * `X-Razorpay-Signature`). The endpoint therefore authenticates on the per-tenant URL tag
 * (`verifyOccTag`), and if a signature header does turn up it must verify — see `verify.ts`.
 * `[VERIFY]` the field names against a recorded payload before the first live merchant.
 */
import { z } from 'zod';
import {
  Address,
  LineItem,
  countryOf,
  currencyOf,
  decimalToMinor,
  firstText,
  itemCountOf,
  itemSummaryOf,
  toDate,
} from './normalise.js';
import type { ParseResult } from './types.js';

const Customer = z
  .object({
    email: z.string().nullish(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    contact: z.string().nullish(),
    phone: z.string().nullish(),
    shipping_address: Address.nullish(),
    billing_address: Address.nullish(),
  })
  .passthrough();

const Body = z
  .object({
    shop_id: z.union([z.string(), z.number()]).nullish(),
    platform: z.string().nullish(),
    token: z.string().nullish(),
    cart_token: z.string().nullish(),
    id: z.union([z.string(), z.number()]).nullish(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    contact: z.string().nullish(),
    abandoned_checkout_url: z.string().nullish(),
    currency: z.string().nullish(),
    line_items: z.array(LineItem).default([]),
    line_items_total: z.union([z.string(), z.number()]).nullish(),
    total_price: z.union([z.string(), z.number()]).nullish(),
    customer: Customer.nullish(),
    created_at: z.unknown().optional(),
    updated_at: z.unknown().optional(),
    completed_at: z.unknown().optional(),
    order_id: z.union([z.string(), z.number()]).nullish(),
    event: z.string().nullish(),
  })
  .passthrough();

export function parseRazorpayMagicCheckout(raw: unknown, receivedAt: Date): ParseResult {
  const parsed = Body.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  const b = parsed.data;

  // `cart_token` is the cart's own identity and survives a page reload; `token` and `id` are
  // fallbacks for older payloads.
  const externalId = firstText(
    b.cart_token,
    b.token,
    b.id === null || b.id === undefined ? null : String(b.id),
  );
  if (externalId === null) return { ok: false, error: 'cart_token: missing' };

  const items = b.line_items;
  const createdAt = toDate(b.created_at, receivedAt);
  const completed =
    b.completed_at !== undefined && b.completed_at !== null
      ? toDate(b.completed_at, receivedAt)
      : b.order_id !== null && b.order_id !== undefined
        ? receivedAt
        : null;

  return {
    ok: true,
    value: {
      provider: 'razorpay_magic',
      externalId,
      createdAt,
      updatedAt: toDate(b.updated_at, createdAt),
      completedAt: completed,
      currency: currencyOf(b.currency),
      totalMinor: decimalToMinor(b.line_items_total ?? b.total_price),
      phone: firstText(
        b.phone,
        b.contact,
        b.customer?.phone,
        b.customer?.contact,
        b.customer?.shipping_address?.phone,
      ),
      countryCode: countryOf(b.customer?.shipping_address, b.customer?.billing_address),
      firstName: firstText(
        b.customer?.first_name,
        b.customer?.shipping_address?.first_name,
        b.customer?.shipping_address?.name,
      ),
      consentAttribute: null,
      customerTags: [],
      itemSummary: itemSummaryOf(items),
      itemCount: itemCountOf(items),
      isDraftOrPos: false,
      eventId: null,
    },
  };
}
