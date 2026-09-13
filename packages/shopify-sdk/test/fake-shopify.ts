import type { GqlOrder } from '../src/reconcile.js';
/**
 * A fake Shopify Admin GraphQL endpoint for tests: a `fetch` implementation that answers the
 * operations the write-back uses, keeps per-order state, and can be told to misbehave
 * (429, 5xx, THROTTLED, a revoked token, a userError). No network, no dependency.
 */

export interface FakeOrder {
  tags: Set<string>;
  note: string | null;
  metafields: Map<string, string>;
  cancelledAt: string | null;
}

export interface FakeSubscription {
  id: string;
  status: 'PENDING' | 'ACTIVE' | 'FROZEN' | 'CANCELLED' | 'DECLINED' | 'EXPIRED';
  test: boolean;
  currentPeriodEnd: string;
  recurring: { amount: string; currencyCode: string };
  capped: { amount: string; currencyCode: string };
  balanceUsed: number;
  usageRecords: Map<string, { id: string; amount: number; description: string }>;
}

export interface FakeShopify {
  readonly fetch: typeof fetch;
  readonly orders: Map<string, FakeOrder>;
  /** Operation names in the order they were received (including failed ones). */
  readonly calls: string[];
  /** Queue of failures to return before answering normally, consumed one per request. */
  readonly failures: ('429' | '503' | 'throttled' | '401' | 'network')[];
  /** Operation name → userError message to return from that mutation (persistent until deleted). */
  readonly userErrors: Map<string, string>;
  /** Tokens accepted; anything else gets 401. */
  readonly tokens: Set<string>;
  readonly subscriptions: Map<string, FakeSubscription>;
  /** Orders returned by NaaradhReconcileOrders (GraphQL Order shape). */
  readonly listedOrders: GqlOrder[];
  billingCurrency: string;
  lastRequest: {
    url: string;
    headers: Record<string, string>;
    body: { query: string; variables: Record<string, unknown> };
  } | null;
}

export function fakeShopify(
  options: { orders?: readonly string[]; token?: string } = {},
): FakeShopify {
  const orders = new Map<string, FakeOrder>();
  for (const id of options.orders ?? []) {
    orders.set(`gid://shopify/Order/${id}`, {
      tags: new Set(),
      note: null,
      metafields: new Map(),
      cancelledAt: null,
    });
  }
  const state: FakeShopify = {
    orders,
    calls: [],
    failures: [],
    userErrors: new Map(),
    tokens: new Set([options.token ?? 'shpat_test']),
    lastRequest: null,
    subscriptions: new Map(),
    listedOrders: [],
    billingCurrency: 'INR',
    fetch: async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      );
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        query: string;
        variables: Record<string, unknown>;
      };
      state.lastRequest = { url, headers, body };
      const op = /(?:mutation|query)\s+(\w+)/.exec(body.query)?.[1] ?? 'unknown';
      state.calls.push(op);
      const json = (status: number, payload: unknown, extra: Record<string, string> = {}) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json', ...extra },
        });

      const failure = state.failures.shift();
      if (failure === 'network') throw new TypeError('fetch failed');
      if (failure === '429') return json(429, { errors: 'Throttled' }, { 'retry-after': '1' });
      if (failure === '503') return json(503, { errors: 'Service unavailable' });
      if (failure === '401') return json(401, { errors: 'Invalid API key or access token' });
      if (failure === 'throttled')
        return json(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] });
      if (!state.tokens.has(headers['x-shopify-access-token'] ?? ''))
        return json(401, { errors: 'Invalid API key or access token' });

      const v = body.variables;
      const order = (id: unknown) => orders.get(String(id));
      const userError = state.userErrors.get(op);
      const errors =
        userError === undefined ? [] : [{ field: null, message: userError, code: 'INVALID' }];
      switch (op) {
        case 'NaaradhTagsAdd': {
          const o = order(v['id']);
          if (o === undefined)
            return json(200, {
              data: {
                tagsAdd: { node: null, userErrors: [{ field: ['id'], message: 'not found' }] },
              },
            });
          if (errors.length === 0) for (const t of v['tags'] as string[]) o.tags.add(t);
          return json(200, { data: { tagsAdd: { node: { id: v['id'] }, userErrors: errors } } });
        }
        case 'NaaradhOrderNote': {
          const input = v['input'] as { id: string; note: string };
          const o = order(input.id);
          if (o !== undefined && errors.length === 0) o.note = input.note;
          return json(200, {
            data: { orderUpdate: { order: { id: input.id }, userErrors: errors } },
          });
        }
        case 'NaaradhMetafieldsSet': {
          for (const m of v['metafields'] as {
            ownerId: string;
            namespace: string;
            key: string;
            value: string;
          }[]) {
            const o = order(m.ownerId);
            if (o !== undefined && errors.length === 0)
              o.metafields.set(`${m.namespace}.${m.key}`, m.value);
          }
          return json(200, { data: { metafieldsSet: { metafields: [], userErrors: errors } } });
        }
        case 'NaaradhOrderState': {
          const o = order(v['id']);
          return json(200, {
            data: { order: o === undefined ? null : { id: v['id'], cancelledAt: o.cancelledAt } },
          });
        }
        case 'NaaradhOrderCancel': {
          const o = order(v['orderId']);
          if (errors.length === 0 && o !== undefined) o.cancelledAt = '2026-09-14T06:31:00Z';
          return json(200, {
            data: {
              orderCancel: {
                job: { id: 'gid://shopify/Job/1', done: false },
                orderCancelUserErrors: errors,
              },
            },
          });
        }
        case 'NaaradhReconcileOrders':
          return json(200, {
            data: {
              orders: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: state.listedOrders,
              },
            },
          });
        case 'NaaradhBillingPreferences':
          return json(200, {
            data: { shopBillingPreferences: { currency: state.billingCurrency } },
          });
        case 'NaaradhSubscriptionCreate': {
          const items = v['lineItems'] as {
            plan: {
              appRecurringPricingDetails?: { price: { amount: string; currencyCode: string } };
              appUsagePricingDetails?: { cappedAmount: { amount: string; currencyCode: string } };
            };
          }[];
          const n = state.subscriptions.size + 1;
          const id = `gid://shopify/AppSubscription/${String(1000 + n)}`;
          const recurring = items.find((i) => i.plan.appRecurringPricingDetails !== undefined)?.plan
            .appRecurringPricingDetails?.price ?? { amount: '0', currencyCode: 'USD' };
          const capped = items.find((i) => i.plan.appUsagePricingDetails !== undefined)?.plan
            .appUsagePricingDetails?.cappedAmount ?? { amount: '0', currencyCode: 'USD' };
          state.subscriptions.set(id, {
            id,
            status: 'PENDING',
            test: v['test'] === true,
            currentPeriodEnd: '2026-10-14T00:00:00Z',
            recurring,
            capped,
            balanceUsed: 0,
            usageRecords: new Map(),
          });
          return json(200, {
            data: {
              appSubscriptionCreate: {
                appSubscription: {
                  id,
                  status: 'PENDING',
                  lineItems: [
                    {
                      id: `${id}/recurring`,
                      plan: { pricingDetails: { __typename: 'AppRecurringPricing' } },
                    },
                    {
                      id: `${id}/usage`,
                      plan: { pricingDetails: { __typename: 'AppUsagePricing' } },
                    },
                  ],
                },
                confirmationUrl: `https://admin.shopify.test/charges/${String(1000 + n)}/confirm`,
                userErrors: errors,
              },
            },
          });
        }
        case 'NaaradhSubscription': {
          const sub = state.subscriptions.get(String(v['id']));
          if (sub === undefined) return json(200, { data: { node: null } });
          return json(200, {
            data: {
              node: {
                id: sub.id,
                name: 'Naaradh',
                status: sub.status,
                test: sub.test,
                currentPeriodEnd: sub.currentPeriodEnd,
                lineItems: [
                  {
                    id: `${sub.id}/recurring`,
                    plan: {
                      pricingDetails: { __typename: 'AppRecurringPricing', price: sub.recurring },
                    },
                  },
                  {
                    id: `${sub.id}/usage`,
                    plan: {
                      pricingDetails: {
                        __typename: 'AppUsagePricing',
                        balanceUsed: {
                          amount: (sub.balanceUsed / 100).toFixed(2),
                          currencyCode: sub.capped.currencyCode,
                        },
                        cappedAmount: sub.capped,
                        terms: 'usage',
                      },
                    },
                  },
                ],
              },
            },
          });
        }
        case 'NaaradhUsageRecordCreate': {
          const lineItem = String(v['subscriptionLineItemId']);
          const sub = state.subscriptions.get(lineItem.replace(/\/usage$/, ''));
          const price = v['price'] as { amount: string; currencyCode: string };
          const minor = Math.round(Number(price.amount) * 100);
          const key = String(v['idempotencyKey']);
          if (sub === undefined || sub.status !== 'ACTIVE')
            return json(200, {
              data: {
                appUsageRecordCreate: {
                  appUsageRecord: null,
                  userErrors: [{ field: null, message: 'Subscription is not active' }],
                },
              },
            });
          const existing = sub.usageRecords.get(key);
          if (existing !== undefined)
            return json(200, {
              data: {
                appUsageRecordCreate: { appUsageRecord: { id: existing.id }, userErrors: [] },
              },
            });
          if (sub.balanceUsed + minor > Math.round(Number(sub.capped.amount) * 100))
            return json(200, {
              data: {
                appUsageRecordCreate: {
                  appUsageRecord: null,
                  userErrors: [{ field: null, message: 'Failed to create usage charge' }],
                },
              },
            });
          const id = `gid://shopify/AppUsageRecord/${String(sub.usageRecords.size + 1)}`;
          sub.usageRecords.set(key, { id, amount: minor, description: String(v['description']) });
          sub.balanceUsed += minor;
          return json(200, {
            data: { appUsageRecordCreate: { appUsageRecord: { id }, userErrors: [] } },
          });
        }
        case 'NaaradhCapUpdate': {
          const sub = state.subscriptions.get(String(v['id']).replace(/\/usage$/, ''));
          if (sub !== undefined)
            sub.capped = v['cappedAmount'] as { amount: string; currencyCode: string };
          return json(200, {
            data: {
              appSubscriptionLineItemUpdate: {
                confirmationUrl: 'https://admin.shopify.test/charges/cap/confirm',
                userErrors: errors,
              },
            },
          });
        }
        case 'NaaradhSubscriptionCancel': {
          const sub = state.subscriptions.get(String(v['id']));
          if (sub !== undefined) sub.status = 'CANCELLED';
          return json(200, {
            data: {
              appSubscriptionCancel: {
                appSubscription: { id: v['id'], status: 'CANCELLED' },
                userErrors: errors,
              },
            },
          });
        }
        default:
          return json(200, {
            errors: [
              { message: `Field '${op}' doesn't exist`, extensions: { code: 'undefinedField' } },
            ],
          });
      }
    },
  };
  return state;
}

/** A GraphQL `Order` node as NaaradhReconcileOrders returns it (fake data, reserved phone range). */
export const gqlOrder = (id: string, over: Partial<GqlOrder> = {}): GqlOrder => ({
  id: `gid://shopify/Order/${id}`,
  legacyResourceId: id,
  name: `#${id}`,
  createdAt: '2026-09-14T06:20:00Z',
  updatedAt: '2026-09-14T06:20:05Z',
  cancelledAt: null,
  test: false,
  tags: ['vip'],
  currencyCode: 'INR',
  totalPriceSet: { shopMoney: { amount: '499.00' } },
  displayFinancialStatus: 'PENDING',
  displayFulfillmentStatus: 'UNFULFILLED',
  paymentGatewayNames: ['Cash on Delivery (COD)'],
  phone: null,
  customer: { firstName: 'Asha', lastName: null },
  shippingAddress: {
    phone: '+916000000001',
    zip: '110001',
    provinceCode: 'DL',
    countryCodeV2: 'IN',
    city: 'Delhi',
  },
  billingAddress: null,
  customAttributes: [{ key: 'naaradh_call_consent', value: 'v1' }],
  lineItems: { nodes: [{ title: 'Kurta', quantity: 2 }] },
  ...over,
});
