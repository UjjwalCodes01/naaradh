import { describe, expect, it } from 'vitest';
import { createAdminClient } from '../src/admin-client.js';
import { ordersCreatedSince, toWebhookShape } from '../src/reconcile.js';
import { parseShopifyOrder } from '../src/webhooks.js';
import { fakeShopify, gqlOrder } from './fake-shopify.js';

describe('hourly reconcile (E-53)', () => {
  it('maps a GraphQL order onto the webhook shape the one parser reads', () => {
    const parsed = parseShopifyOrder(toWebhookShape(gqlOrder('1001')));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.order.id).toBe(1001);
    expect(parsed.value.phone).toBe('+916000000001');
    expect(parsed.value.customerName).toBe('Asha');
    expect(parsed.value.callConsentAttribute).toBe('v1');
    expect(parsed.value.itemCount).toBe(2);
    expect(parsed.value.order.financial_status).toBe('pending');
  });

  it('asks Shopify for orders created after the watermark', async () => {
    const fake = fakeShopify();
    fake.listedOrders.push(gqlOrder('1001'), gqlOrder('1002'));
    const client = createAdminClient({
      shop: 'client-a-dev.myshopify.com',
      accessToken: 'shpat_test',
      apiVersion: '2026-07',
      fetchImpl: fake.fetch,
      sleep: async () => undefined,
    });
    const orders = await ordersCreatedSince(client, new Date('2026-09-14T05:30:00Z'));
    expect(orders.map((o) => o['id'])).toEqual([1001, 1002]);
    expect(fake.lastRequest?.body.variables['query']).toBe(
      "created_at:>'2026-09-14T05:30:00.000Z'",
    );
  });
});
