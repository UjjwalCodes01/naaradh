import type { AdminClient } from './admin-client.js';

/**
 * Hourly order reconciliation (E-53, P2-SHOP-5). Webhooks are at-least-once but not
 * guaranteed; this lists the orders created since a point in time and hands them to the same
 * ingestion path as `orders/create` — mapped to the webhook's REST shape so there is ONE parser
 * (`parseShopifyOrder`). Intent creation is idempotent per (shop, order, use case), so an order
 * the webhook already delivered is a no-op (E-52); one found too late keeps its original 30-minute
 * envelope and is refused by the gate at dispatch (invariant 4).
 *
 * Only order fields Naaradh uses are requested (protected customer data minimisation).
 */

const ORDERS = /* GraphQL */ `
  query NaaradhReconcileOrders($query: String!, $after: String) {
    orders(first: 50, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        legacyResourceId
        name
        createdAt
        updatedAt
        cancelledAt
        test
        tags
        currencyCode
        totalPriceSet {
          shopMoney {
            amount
          }
        }
        displayFinancialStatus
        displayFulfillmentStatus
        paymentGatewayNames
        phone
        customer {
          firstName
          lastName
        }
        shippingAddress {
          phone
          zip
          provinceCode
          countryCodeV2
          city
        }
        billingAddress {
          phone
          countryCodeV2
        }
        customAttributes {
          key
          value
        }
        lineItems(first: 20) {
          nodes {
            title
            quantity
          }
        }
      }
    }
  }
`;

export interface GqlOrder {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  updatedAt: string | null;
  cancelledAt: string | null;
  test: boolean;
  tags: string[];
  currencyCode: string;
  totalPriceSet: { shopMoney: { amount: string } };
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  paymentGatewayNames: string[];
  phone: string | null;
  customer: { firstName: string | null; lastName: string | null } | null;
  shippingAddress: {
    phone: string | null;
    zip: string | null;
    provinceCode: string | null;
    countryCodeV2: string | null;
    city: string | null;
  } | null;
  billingAddress: { phone: string | null; countryCodeV2: string | null } | null;
  customAttributes: { key: string; value: string | null }[];
  lineItems: { nodes: { title: string; quantity: number }[] };
}

/** The `orders/create` webhook's shape, as parseShopifyOrder() reads it. */
export function toWebhookShape(o: GqlOrder): Record<string, unknown> {
  const lower = (s: string | null) => (s === null ? null : s.toLowerCase());
  return {
    id: Number(o.legacyResourceId),
    admin_graphql_api_id: o.id,
    name: o.name,
    created_at: o.createdAt,
    ...(o.updatedAt === null ? {} : { updated_at: o.updatedAt }),
    cancelled_at: o.cancelledAt,
    test: o.test,
    tags: o.tags.join(', '),
    currency: o.currencyCode,
    total_price: o.totalPriceSet.shopMoney.amount,
    financial_status: lower(o.displayFinancialStatus),
    fulfillment_status: lower(o.displayFulfillmentStatus),
    payment_gateway_names: o.paymentGatewayNames,
    phone: o.phone,
    note_attributes: o.customAttributes.map((a) => ({ name: a.key, value: a.value })),
    customer:
      o.customer === null
        ? null
        : { first_name: o.customer.firstName, last_name: o.customer.lastName },
    shipping_address:
      o.shippingAddress === null
        ? null
        : {
            phone: o.shippingAddress.phone,
            zip: o.shippingAddress.zip,
            province_code: o.shippingAddress.provinceCode,
            country_code: o.shippingAddress.countryCodeV2,
            city: o.shippingAddress.city,
          },
    billing_address:
      o.billingAddress === null
        ? null
        : { phone: o.billingAddress.phone, country_code: o.billingAddress.countryCodeV2 },
    line_items: o.lineItems.nodes.map((li) => ({ title: li.title, quantity: li.quantity })),
  };
}

/** Orders created after `since`, oldest first, capped at `maxPages` × 50. */
export async function ordersCreatedSince(
  client: AdminClient,
  since: Date,
  maxPages = 5,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data: {
      orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlOrder[] };
    } = await client.request(ORDERS, {
      query: `created_at:>'${since.toISOString()}'`,
      ...(after === null ? {} : { after }),
    });
    out.push(...data.orders.nodes.map(toWebhookShape));
    if (!data.orders.pageInfo.hasNextPage || data.orders.pageInfo.endCursor === null) break;
    after = data.orders.pageInfo.endCursor;
  }
  return out;
}
