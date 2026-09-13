import { describe, expect, it } from 'vitest';
import { createAdminClient, ShopifyRequestError } from '../src/admin-client.js';
import {
  billingCurrency,
  cancelSubscription,
  createSubscription,
  createUsageRecord,
  fetchSubscription,
  fromMoneyV2,
  requestCapChange,
  toMoneyInput,
} from '../src/billing.js';
import { ShopifyUserError } from '../src/orders.js';
import { fakeShopify } from './fake-shopify.js';

const client = (fake: ReturnType<typeof fakeShopify>) =>
  createAdminClient({
    shop: 'client-a-dev.myshopify.com',
    accessToken: 'shpat_test',
    apiVersion: '2026-07',
    fetchImpl: fake.fetch,
    sleep: async () => undefined,
  });

async function activeSub(fake: ReturnType<typeof fakeShopify>, capMinor = 50_000) {
  const c = client(fake);
  const created = await createSubscription(c, {
    name: 'Naaradh Growth',
    returnUrl: 'https://shopify.naaradh.test/billing/return',
    recurring: { minor: 499_900, currency: 'INR' },
    cappedAmount: { minor: capMinor, currency: 'INR' },
    terms: '₹8 per confirmed order beyond 500 a month',
    test: true,
  });
  const sub = fake.subscriptions.get(created.subscriptionId);
  if (sub !== undefined) sub.status = 'ACTIVE';
  return { c, created };
}

describe('Shopify Billing API (P2-SHOP-3)', () => {
  it('money crosses as integer minor units; Shopify sees decimal strings', () => {
    expect(toMoneyInput({ minor: 499_900, currency: 'INR' })).toEqual({
      amount: '4999.00',
      currencyCode: 'INR',
    });
    expect(toMoneyInput({ minor: 10, currency: 'USD' })).toEqual({
      amount: '0.10',
      currencyCode: 'USD',
    });
    expect(fromMoneyV2({ amount: '4999.0', currencyCode: 'INR' })).toEqual({
      minor: 499_900,
      currency: 'INR',
    });
    expect(() => toMoneyInput({ minor: -1, currency: 'INR' })).toThrow(ShopifyRequestError);
    expect(() => toMoneyInput({ minor: 1.5, currency: 'INR' })).toThrow(ShopifyRequestError);
  });

  it('reads the merchant billing currency', async () => {
    const fake = fakeShopify();
    fake.billingCurrency = 'USD';
    expect(await billingCurrency(client(fake))).toBe('USD');
  });

  it('creates a recurring + capped usage subscription and returns where the merchant approves it', async () => {
    const fake = fakeShopify();
    const r = await createSubscription(client(fake), {
      name: 'Naaradh Starter',
      returnUrl: 'https://shopify.naaradh.test/billing/return',
      recurring: { minor: 199_900, currency: 'INR' },
      cappedAmount: { minor: 100_000, currency: 'INR' },
      terms: 'usage',
      test: true,
    });
    expect(r.confirmationUrl).toMatch(/^https:\/\/admin\.shopify\.test\/charges\//);
    expect(r.usageLineItemId).toBe(`${r.subscriptionId}/usage`);
    const sent = fake.lastRequest?.body.variables['lineItems'] as {
      plan: Record<string, unknown>;
    }[];
    expect(sent[0]?.plan).toEqual({
      appRecurringPricingDetails: {
        price: { amount: '1999.00', currencyCode: 'INR' },
        interval: 'EVERY_30_DAYS',
      },
    });
    expect(sent[1]?.plan).toEqual({
      appUsagePricingDetails: {
        cappedAmount: { amount: '1000.00', currencyCode: 'INR' },
        terms: 'usage',
      },
    });
  });

  it('fetches the subscription as the source of truth, with balance and cap', async () => {
    const fake = fakeShopify();
    const { c, created } = await activeSub(fake);
    const s = await fetchSubscription(c, created.subscriptionId);
    expect(s).toMatchObject({
      status: 'ACTIVE',
      test: true,
      recurring: { minor: 499_900, currency: 'INR' },
      cappedAmount: { minor: 50_000, currency: 'INR' },
      balanceUsed: { minor: 0 },
    });
    expect(await fetchSubscription(c, 'gid://shopify/AppSubscription/9')).toBeNull();
  });

  it('usage records: idempotent by key, refused over the cap', async () => {
    const fake = fakeShopify();
    const { c, created } = await activeSub(fake, 1_500);
    const lineItemId = created.usageLineItemId ?? '';
    const a = await createUsageRecord(c, {
      lineItemId,
      price: { minor: 800, currency: 'INR' },
      description: 'outcome',
      idempotencyKey: 'led_1',
    });
    const again = await createUsageRecord(c, {
      lineItemId,
      price: { minor: 800, currency: 'INR' },
      description: 'outcome',
      idempotencyKey: 'led_1',
    });
    expect(again).toBe(a);
    expect(fake.subscriptions.get(created.subscriptionId)?.balanceUsed).toBe(800);
    await expect(
      createUsageRecord(c, {
        lineItemId,
        price: { minor: 800, currency: 'INR' },
        description: 'outcome',
        idempotencyKey: 'led_2',
      }),
    ).rejects.toBeInstanceOf(ShopifyUserError);
    await expect(
      createUsageRecord(c, {
        lineItemId,
        price: { minor: 1, currency: 'INR' },
        description: 'x',
        idempotencyKey: 'k'.repeat(256),
      }),
    ).rejects.toBeInstanceOf(ShopifyRequestError);
  });

  it('raising the cap returns an approval URL; cancelling works', async () => {
    const fake = fakeShopify();
    const { c, created } = await activeSub(fake);
    expect(
      await requestCapChange(c, created.usageLineItemId ?? '', { minor: 200_000, currency: 'INR' }),
    ).toMatch(/confirm$/);
    await cancelSubscription(c, created.subscriptionId);
    expect(fake.subscriptions.get(created.subscriptionId)?.status).toBe('CANCELLED');
  });
});
