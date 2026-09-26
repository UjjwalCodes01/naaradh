/**
 * Cashfree One Click Checkout — abandoned checkout webhook.
 *
 * Shape from Cashfree's published reference (cashfree.com/docs/payments/checkout/
 * abandoned-checkout/webhook, read Sep 2026): `{ type: 'ABANDONED_CHECKOUT', event_time, data }`,
 * where `data` carries `cart_id`, `cart_token`, `abandoned_checkout_url`, `total_price`,
 * `line_items[]`, and — only once the shopper has got that far — `phone` and a `customer`
 * object with `email`, names and `shipping_address`.
 *
 * `[VERIFY]` against a recorded payload before the first live merchant (docs/go-live/09 §3).
 * Everything optional is optional on purpose: a cart webhook arrives at several stages of the
 * checkout, and the early ones have no contact details at all. Those are still recorded, because
 * the shopper may type a phone later and `recordCheckout` keeps the newest state of the cart.
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
    phone: z.string().nullish(),
    shipping_address: Address.nullish(),
    billing_address: Address.nullish(),
  })
  .passthrough();

const Data = z
  .object({
    cart_id: z.union([z.string(), z.number()]).nullish(),
    cart_token: z.string().nullish(),
    store_url: z.string().nullish(),
    abandoned_checkout_url: z.string().nullish(),
    total_price: z.union([z.string(), z.number()]).nullish(),
    original_total_price: z.union([z.string(), z.number()]).nullish(),
    currency: z.string().nullish(),
    phone: z.string().nullish(),
    customer: Customer.nullish(),
    line_items: z.array(LineItem).default([]),
    created_at: z.unknown().optional(),
    updated_at: z.unknown().optional(),
    completed_at: z.unknown().optional(),
    order_id: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

const Envelope = z
  .object({
    type: z.string().nullish(),
    event_time: z.unknown().optional(),
    data: Data,
  })
  .passthrough();

/** The only event this endpoint acts on; anything else is recorded and ignored. */
export const CASHFREE_ABANDONED_TYPE = 'ABANDONED_CHECKOUT';

export function parseCashfreeCheckout(raw: unknown, receivedAt: Date): ParseResult {
  const parsed = Envelope.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  const { type, event_time: eventTime, data } = parsed.data;
  if (typeof type === 'string' && type.toUpperCase() !== CASHFREE_ABANDONED_TYPE)
    return { ok: false, error: `unhandled type: ${type}` };

  // cart_id is the documented identifier; cart_token is the fallback for older payloads.
  const externalId = firstText(
    data.cart_id === null || data.cart_id === undefined ? null : String(data.cart_id),
    data.cart_token,
  );
  if (externalId === null) return { ok: false, error: 'data.cart_id: missing' };

  const items = data.line_items;
  const createdAt = toDate(data.created_at, toDate(eventTime, receivedAt));
  // A cart that has become an order carries order_id; treat that as completed so no call goes out.
  const completed =
    data.completed_at !== undefined && data.completed_at !== null
      ? toDate(data.completed_at, receivedAt)
      : data.order_id !== null && data.order_id !== undefined
        ? toDate(eventTime, receivedAt)
        : null;

  return {
    ok: true,
    value: {
      provider: 'cashfree',
      externalId,
      createdAt,
      updatedAt: toDate(data.updated_at, toDate(eventTime, receivedAt)),
      completedAt: completed,
      currency: currencyOf(data.currency),
      totalMinor: decimalToMinor(data.total_price ?? data.original_total_price),
      phone: firstText(
        data.phone,
        data.customer?.phone,
        data.customer?.shipping_address?.phone,
        data.customer?.billing_address?.phone,
      ),
      countryCode: countryOf(data.customer?.shipping_address, data.customer?.billing_address),
      firstName: firstText(
        data.customer?.first_name,
        data.customer?.shipping_address?.first_name,
        data.customer?.shipping_address?.name,
      ),
      // Cashfree passes no cart attributes through, so our checkbox cannot travel this way.
      consentAttribute: null,
      customerTags: [],
      itemSummary: itemSummaryOf(items),
      itemCount: itemCountOf(items),
      isDraftOrPos: false,
      eventId: null,
    },
  };
}
