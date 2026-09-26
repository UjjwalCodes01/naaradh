/**
 * GoKwik and Shiprocket Checkout — abandoned cart webhooks.
 *
 * Neither provider publishes a payload reference: both wire the webhook up for the merchant from
 * their own dashboard, and what they document publicly is only that the body carries the
 * shopper's name and phone, the cart's items and a recovery link (GoKwik's merchant integration
 * team adds the URL; Shiprocket Checkout is the same). Both replace Shopify's checkout, and both
 * payloads that *are* public in this family — Cashfree's and Razorpay Magic's — are Shopify's
 * abandoned-checkout object with the same key names, so this mapping accepts that family and the
 * handful of spellings these two are reported to use.
 *
 * `[VERIFY]` — the first recorded payload from each provider replaces this with an exact schema
 * (docs/go-live/09 §3). Until then the rule is: read what we recognise, ignore the rest, and never
 * guess a phone number. A cart with no readable phone is still recorded (the shopper may type one
 * on a later event) but can never be called, because the dispatcher has nothing to dial.
 *
 * Safety: nothing here decides to call anyone. `abandoned_cart` is promotional, so a cart only
 * becomes a call when the consent ledger already holds consent for that number (invariant 5) and
 * the gate agrees. A forged body cannot manufacture consent.
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
    name: z.string().nullish(),
    phone: z.string().nullish(),
    contact: z.string().nullish(),
    mobile: z.string().nullish(),
    shipping_address: Address.nullish(),
    billing_address: Address.nullish(),
  })
  .passthrough();

const Body = z
  .object({
    // Cart identity, in the order of preference these providers are reported to use.
    cart_id: z.union([z.string(), z.number()]).nullish(),
    cart_token: z.string().nullish(),
    checkout_id: z.union([z.string(), z.number()]).nullish(),
    order_request_id: z.string().nullish(),
    id: z.union([z.string(), z.number()]).nullish(),
    token: z.string().nullish(),

    // Contact, at the top level or on the customer.
    phone: z.string().nullish(),
    mobile: z.string().nullish(),
    contact: z.string().nullish(),
    phone_number: z.string().nullish(),
    email: z.string().nullish(),
    customer_name: z.string().nullish(),
    first_name: z.string().nullish(),
    customer: Customer.nullish(),
    shipping_address: Address.nullish(),
    billing_address: Address.nullish(),

    // Money and contents.
    currency: z.string().nullish(),
    total_price: z.union([z.string(), z.number()]).nullish(),
    total: z.union([z.string(), z.number()]).nullish(),
    cart_value: z.union([z.string(), z.number()]).nullish(),
    amount: z.union([z.string(), z.number()]).nullish(),
    line_items: z.array(LineItem).nullish(),
    items: z.array(LineItem).nullish(),
    products: z.array(LineItem).nullish(),

    // Lifecycle.
    created_at: z.unknown().optional(),
    updated_at: z.unknown().optional(),
    completed_at: z.unknown().optional(),
    order_id: z.union([z.string(), z.number()]).nullish(),
    event: z.string().nullish(),
    event_id: z.string().nullish(),
    abandoned_checkout_url: z.string().nullish(),
    recovery_url: z.string().nullish(),
  })
  .passthrough();

/** Wrapped bodies: some providers nest the cart under `data`, `payload` or `cart`. */
const Wrapper = z
  .object({
    data: z.unknown().optional(),
    payload: z.unknown().optional(),
    cart: z.unknown().optional(),
    event: z.string().nullish(),
    event_id: z.string().nullish(),
    type: z.string().nullish(),
  })
  .passthrough();

function unwrap(raw: unknown): { body: unknown; event: string | null; eventId: string | null } {
  const outer = Wrapper.safeParse(raw);
  if (!outer.success) return { body: raw, event: null, eventId: null };
  const inner = outer.data.data ?? outer.data.payload ?? outer.data.cart;
  return {
    body: inner !== undefined && inner !== null && typeof inner === 'object' ? inner : raw,
    event: firstText(outer.data.event, outer.data.type),
    eventId: firstText(outer.data.event_id),
  };
}

export function parseGenericCartWebhook(
  provider: 'gokwik' | 'shiprocket',
  raw: unknown,
  receivedAt: Date,
): ParseResult {
  const { body, event, eventId } = unwrap(raw);
  const parsed = Body.safeParse(body);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  const b = parsed.data;

  const str = (v: string | number | null | undefined): string | null =>
    v === null || v === undefined ? null : String(v);
  const externalId = firstText(
    str(b.cart_id),
    b.cart_token,
    str(b.checkout_id),
    b.order_request_id,
    b.token,
    str(b.id),
  );
  if (externalId === null)
    return { ok: false, error: 'cart id: none of the known keys is present' };

  const items = b.line_items ?? b.items ?? b.products ?? [];
  const createdAt = toDate(b.created_at, receivedAt);
  // Completed means "do not call": an explicit timestamp, an order id, or an event name that
  // says the cart turned into an order. Each provider uses a different one of the three.
  const completed =
    b.completed_at !== undefined && b.completed_at !== null
      ? toDate(b.completed_at, receivedAt)
      : (b.order_id !== null && b.order_id !== undefined) ||
          looksCompleted(event) ||
          looksCompleted(firstText(b.event))
        ? receivedAt
        : null;

  return {
    ok: true,
    value: {
      provider,
      externalId,
      createdAt,
      updatedAt: toDate(b.updated_at, createdAt),
      completedAt: completed,
      currency: currencyOf(b.currency),
      totalMinor: decimalToMinor(b.total_price ?? b.total ?? b.cart_value ?? b.amount),
      phone: firstText(
        b.phone,
        b.mobile,
        b.contact,
        b.phone_number,
        b.customer?.phone,
        b.customer?.mobile,
        b.customer?.contact,
        b.shipping_address?.phone,
        b.customer?.shipping_address?.phone,
      ),
      countryCode: countryOf(
        b.shipping_address,
        b.billing_address,
        b.customer?.shipping_address,
        b.customer?.billing_address,
      ),
      firstName: firstText(
        b.first_name,
        b.customer_name,
        b.customer?.first_name,
        b.customer?.name,
        b.shipping_address?.first_name,
        b.shipping_address?.name,
      ),
      consentAttribute: null,
      customerTags: [],
      itemSummary: itemSummaryOf(items),
      itemCount: itemCountOf(items),
      isDraftOrPos: false,
      eventId: eventId ?? firstText(b.event_id) ?? null,
    },
  };
}

/** Event names these providers use for "the cart was completed", where they send one. */
export function looksCompleted(event: string | null): boolean {
  if (event === null) return false;
  const e = event.toLowerCase();
  return (
    e.includes('order') && (e.includes('create') || e.includes('placed') || e.includes('paid'))
  );
}
