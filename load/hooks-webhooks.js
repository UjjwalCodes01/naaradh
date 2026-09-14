import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, fakePhone, hmacBase64, required, summary } from './lib.js';

/**
 * 500 Shopify `orders/create` webhooks in 60 seconds against hooks (SPEC §14, AGENTS §12).
 * SLO: webhook ack p99 < 800 ms (SPEC §6.8); Shopify drops a subscription that keeps timing out.
 *
 *   k6 run -e HOOKS_URL=https://hooks.stage.naaradh.com \
 *          -e SHOPIFY_SECRET=<the STAGING app's client secret> \
 *          -e SHOP_DOMAIN=<a dev store connected to staging>.myshopify.com load/hooks-webhooks.js
 *
 * Every order is COD (manual gateway) with a customer in the fake range, so staging's simulator
 * engine "dials" it and nothing rings anywhere. Unique order ids per run: the dedupe on
 * X-Shopify-Webhook-Id would otherwise turn the run into 499 duplicates.
 */

const HOOKS = baseUrl('HOOKS_URL');
const SECRET = required('SHOPIFY_SECRET');
const SHOP = required('SHOP_DOMAIN');
const RUN = `${Date.now().toString(36)}`;

export const options = {
  scenarios: {
    orders: {
      executor: 'constant-arrival-rate',
      rate: 500,
      timeUnit: '60s',
      duration: '60s',
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<800', 'p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

function order(n) {
  const id = 9_000_000_000 + n;
  const phone = fakePhone(n);
  return {
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    name: `#L${n}`,
    order_number: 100000 + n,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    currency: 'INR',
    total_price: '1299.00',
    financial_status: 'pending',
    fulfillment_status: null,
    cancelled_at: null,
    test: false,
    tags: '',
    gateway: 'Cash on Delivery (COD)',
    payment_gateway_names: ['Cash on Delivery (COD)'],
    phone,
    customer: { id: 7_000_000_000 + n, first_name: 'Load', last_name: 'Test', phone },
    shipping_address: {
      first_name: 'Load',
      last_name: 'Test',
      phone,
      zip: '110001',
      province: 'Delhi',
      country_code: 'IN',
    },
    line_items: [{ id: 1, title: 'Kurta', quantity: 1, price: '1299.00' }],
  };
}

export default function () {
  const n = __VU * 100000 + __ITER;
  const body = JSON.stringify(order(n));
  const res = http.post(`${HOOKS}/shopify/webhooks`, body, {
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Topic': 'orders/create',
      'X-Shopify-Shop-Domain': SHOP,
      'X-Shopify-Webhook-Id': `load-${RUN}-${n}`,
      'X-Shopify-Hmac-Sha256': hmacBase64(SECRET, body),
      'X-Shopify-API-Version': '2026-07',
    },
    tags: { name: 'shopify_orders_create' },
  });
  check(res, {
    'status 200': (r) => r.status === 200,
    'published (not rejected)': (r) =>
      r.status === 200 && !/rejected|invalid signature/.test(r.body),
  });
}

export function handleSummary(data) {
  return summary(data, 'load/results/hooks-webhooks.json');
}
