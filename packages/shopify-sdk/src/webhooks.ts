import { z } from 'zod';

/**
 * The subset of Shopify's `orders/*` webhook payload we consume, validated at the boundary.
 * Everything else in the payload is ignored (data minimisation for Level 2 PCD). Protected
 * fields (phone, name) arrive as null until Level 2 is approved — every field is nullable and
 * the intents consumer turns a missing phone into gate reason number:missing (E-43).
 */

const money = z.string().regex(/^-?\d+(\.\d{1,2})?$/);

export const ShopifyOrderWebhook = z.object({
  id: z.number().int(),
  admin_graphql_api_id: z.string().optional(),
  name: z.string(), // "#1001"
  order_number: z.number().int().optional(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }).optional(),
  cancelled_at: z.string().datetime({ offset: true }).nullable().optional(),
  cancel_reason: z.string().nullable().optional(),
  test: z.boolean().optional(),
  tags: z.string().optional(),
  currency: z.string().length(3),
  total_price: money,
  financial_status: z.string().nullable().optional(),
  fulfillment_status: z.string().nullable().optional(),
  payment_gateway_names: z.array(z.string()).default([]),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  note_attributes: z
    .array(z.object({ name: z.string(), value: z.string().nullable() }))
    .default([]),
  customer: z
    .object({
      id: z.number().int().optional(),
      first_name: z.string().nullable().optional(),
      last_name: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      tags: z.string().optional(),
    })
    .nullable()
    .optional(),
  shipping_address: z
    .object({
      phone: z.string().nullable().optional(),
      zip: z.string().nullable().optional(),
      province: z.string().nullable().optional(),
      province_code: z.string().nullable().optional(),
      country_code: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  billing_address: z
    .object({
      phone: z.string().nullable().optional(),
      country_code: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  line_items: z
    .array(
      z.object({
        title: z.string(),
        quantity: z.number().int(),
      }),
    )
    .default([]),
});

export type ShopifyOrder = z.infer<typeof ShopifyOrderWebhook>;

export const ShopifyOrderCancelledWebhook = ShopifyOrderWebhook.pick({
  id: true,
  name: true,
  cancelled_at: true,
  cancel_reason: true,
});

export interface ParsedShopifyOrder {
  readonly order: ShopifyOrder;
  /** First non-empty of shipping phone, order phone, customer phone, billing phone. */
  readonly phone: string | null;
  readonly customerName: string | null;
  readonly isTest: boolean;
  readonly tags: readonly string[];
  readonly customerTags: readonly string[];
  /** The custom checkout attribute the consent extension writes (E-13). */
  readonly callConsentAttribute: string | null;
  readonly itemSummary: string;
  readonly itemCount: number;
}

export function parseShopifyOrder(
  raw: unknown,
): { ok: true; value: ParsedShopifyOrder } | { ok: false; error: string } {
  const r = ShopifyOrderWebhook.safeParse(raw);
  if (!r.success)
    return {
      ok: false,
      error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  const o = r.data;
  const phone = [
    o.shipping_address?.phone,
    o.phone,
    o.customer?.phone,
    o.billing_address?.phone,
  ].find((p): p is string => typeof p === 'string' && p.trim().length > 0);
  const name = [o.customer?.first_name, o.customer?.last_name]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ');
  const split = (s: string | undefined) =>
    s === undefined
      ? []
      : s
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
  const items = o.line_items;
  const itemCount = items.reduce((n, li) => n + li.quantity, 0);
  const itemSummary =
    items.length === 0
      ? ''
      : items.length === 1
        ? `${String(items[0]?.quantity ?? 1)} × ${items[0]?.title ?? ''}`
        : `${String(itemCount)} items`;
  const consent = o.note_attributes.find((a) => a.name === 'naaradh_call_consent')?.value ?? null;
  return {
    ok: true,
    value: {
      order: o,
      phone: phone ?? null,
      customerName: name.length > 0 ? name : null,
      isTest: o.test === true,
      tags: split(o.tags),
      customerTags: split(o.customer?.tags),
      callConsentAttribute: consent,
      itemSummary,
      itemCount,
    },
  };
}

/**
 * fulfillments/create and fulfillments/update — tracking for the order cache (ADR-0006), so
 * the voice agent can answer "where is my order". Only carrier, number, URL and status.
 */
export const ShopifyFulfillmentWebhook = z.object({
  id: z.number().int(),
  order_id: z.number().int(),
  status: z.string().nullable().optional(),
  shipment_status: z.string().nullable().optional(),
  tracking_company: z.string().nullable().optional(),
  tracking_number: z.string().nullable().optional(),
  tracking_numbers: z.array(z.string()).optional(),
  tracking_url: z.string().nullable().optional(),
  tracking_urls: z.array(z.string()).optional(),
  estimated_delivery_at: z.string().nullable().optional(),
  updated_at: z.string().optional(),
});

export interface ParsedFulfillment {
  readonly orderId: string;
  /** For orders.fulfillment_status: the shipment status when known, else 'fulfilled'/'cancelled'. */
  readonly fulfillmentStatus: string | null;
  readonly tracking: {
    readonly company: string | null;
    readonly number: string | null;
    readonly url: string | null;
    readonly status: string | null;
    readonly estimatedDelivery: string | null;
  };
}

export function parseShopifyFulfillment(
  raw: unknown,
): { ok: true; value: ParsedFulfillment } | { ok: false; error: string } {
  const r = ShopifyFulfillmentWebhook.safeParse(raw);
  if (!r.success)
    return {
      ok: false,
      error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  const f = r.data;
  const shipment = f.shipment_status ?? null;
  const status =
    f.status === 'cancelled' || f.status === 'failure'
      ? null
      : (shipment ?? (f.status === 'success' ? 'fulfilled' : null));
  const cut = (v: string | null | undefined, n: number) =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, n) : null;
  return {
    ok: true,
    value: {
      orderId: String(f.order_id),
      fulfillmentStatus: status,
      tracking: {
        company: cut(f.tracking_company, 80),
        number: cut(f.tracking_number ?? f.tracking_numbers?.[0], 80),
        url: cut(f.tracking_url ?? f.tracking_urls?.[0], 500),
        status: cut(shipment ?? f.status, 40),
        estimatedDelivery: cut(f.estimated_delivery_at, 40),
      },
    },
  };
}
