import { describe, expect, it } from 'vitest';
import {
  ShopifyAuthError,
  ShopifyRequestError,
  ShopifyRetryableError,
  createAdminClient,
} from '../src/admin-client.js';
import { ShopifyUserError, applyOrderWriteback, cancelOrder, toOrderGid } from '../src/orders.js';
import { FLOW_TRIGGER_HANDLE, fireCallCompletedTrigger } from '../src/flow.js';
import { fakeShopify } from './fake-shopify.js';

const SHOP = 'client-a-dev.myshopify.com';
const noSleep = async () => undefined;
const client = (
  fake: ReturnType<typeof fakeShopify>,
  extra: Partial<Parameters<typeof createAdminClient>[0]> = {},
) =>
  createAdminClient({
    shop: SHOP,
    accessToken: 'shpat_test',
    apiVersion: '2026-07',
    fetchImpl: fake.fetch,
    sleep: noSleep,
    ...extra,
  });

const plan = {
  tags: ['naaradh:cod-cancelled'],
  note: 'Naaradh · 2026-09-14T06:30:00.000Z · cancelled · recording in app',
  metafields: { cod_status: 'cancelled', outcome_ref: 'out_x' },
  cancelOrder: true,
};

describe('admin client (P1-SHOP-2)', () => {
  it('posts to the pinned version with the token header, never in the URL', async () => {
    const fake = fakeShopify({ orders: ['5001'] });
    await applyOrderWriteback(client(fake), '5001', { ...plan, cancelOrder: false });
    expect(fake.lastRequest?.url).toBe(`https://${SHOP}/admin/api/2026-07/graphql.json`);
    expect(fake.lastRequest?.headers['x-shopify-access-token']).toBe('shpat_test');
    expect(fake.lastRequest?.url).not.toContain('shpat_test');
  });

  it('refuses a shop that is not a myshopify.com domain (no SSRF through integrations.external_id)', () => {
    const fake = fakeShopify();
    for (const shop of [
      'evil.example.com',
      'x.myshopify.com.evil.io',
      'https://x.myshopify.com',
      '169.254.169.254',
    ]) {
      expect(() => client(fake, { shop })).toThrow(ShopifyRequestError);
    }
  });

  it('retries 429, 5xx, THROTTLED and network errors in-process, then succeeds', async () => {
    const fake = fakeShopify({ orders: ['5001'] });
    fake.failures.push('429', 'throttled');
    await applyOrderWriteback(client(fake), '5001', { ...plan, cancelOrder: false });
    expect(fake.orders.get(toOrderGid('5001'))?.tags.has('naaradh:cod-cancelled')).toBe(true);
    fake.failures.push('503', 'network');
    await applyOrderWriteback(client(fake), '5001', { ...plan, cancelOrder: false });
  });

  it('gives up after maxAttempts and surfaces a retryable error for the caller to reschedule', async () => {
    const fake = fakeShopify({ orders: ['5001'] });
    fake.failures.push('503', '503', '503');
    await expect(applyOrderWriteback(client(fake), '5001', plan)).rejects.toBeInstanceOf(
      ShopifyRetryableError,
    );
  });

  it('does not sleep through a long Retry-After — that is the caller’s retry to schedule', async () => {
    const fake = fakeShopify({ orders: ['5001'] });
    fake.failures.push('429');
    const slept: number[] = [];
    const c = client(fake, { maxBackoffMs: 500, sleep: async (ms) => void slept.push(ms) });
    await expect(applyOrderWriteback(c, '5001', plan)).rejects.toMatchObject({
      name: 'ShopifyRetryableError',
      retryAfterSec: 1,
    });
    expect(slept).toEqual([]);
  });

  it('a revoked token is an auth error, not retried', async () => {
    const fake = fakeShopify({ orders: ['5001'], token: 'shpat_other' });
    await expect(applyOrderWriteback(client(fake), '5001', plan)).rejects.toBeInstanceOf(
      ShopifyAuthError,
    );
    expect(fake.calls).toHaveLength(1);
  });

  it('a GraphQL schema error is loud and not retried (a bug, not a blip)', async () => {
    const fake = fakeShopify();
    const c = client(fake);
    await expect(c.request('query NaaradhUnknown { shop { id } }')).rejects.toBeInstanceOf(
      ShopifyRequestError,
    );
    expect(fake.calls).toHaveLength(1);
  });
});

describe('order write-back operations', () => {
  it('tags, note and metafields land before the cancel; the cancel is reason CUSTOMER, restocked, no refund, customer notified', async () => {
    const fake = fakeShopify({ orders: ['5001'] });
    const r = await applyOrderWriteback(client(fake), '5001', plan);
    expect(fake.calls).toEqual([
      'NaaradhTagsAdd',
      'NaaradhOrderNote',
      'NaaradhMetafieldsSet',
      'NaaradhOrderState',
      'NaaradhOrderCancel',
    ]);
    const o = fake.orders.get('gid://shopify/Order/5001');
    expect([...(o?.tags ?? [])]).toEqual(['naaradh:cod-cancelled']);
    expect(o?.note).toBe(plan.note);
    expect(o?.metafields.get('naaradh.cod_status')).toBe('cancelled');
    expect(o?.cancelledAt).not.toBeNull();
    expect(r.cancel).toMatchObject({ kind: 'submitted', done: false });
    const v = fake.lastRequest?.body.variables ?? {};
    expect(v).toMatchObject({ reason: 'CUSTOMER', restock: true, notifyCustomer: true });
    expect(v).not.toHaveProperty('refundMethod');
  });

  it('a retried write-back converges: tags not duplicated, an already-cancelled order is not cancelled twice', async () => {
    const fake = fakeShopify({ orders: ['5001'] });
    await applyOrderWriteback(client(fake), '5001', plan);
    fake.calls.length = 0;
    const again = await applyOrderWriteback(client(fake), '5001', plan);
    expect(again.cancel).toEqual({ kind: 'already_cancelled' });
    expect(fake.calls).not.toContain('NaaradhOrderCancel');
    expect(fake.orders.get('gid://shopify/Order/5001')?.tags.size).toBe(1);
  });

  it('Shopify refusing the cancel (userErrors) is a ShopifyUserError — the audit trail is still on the order', async () => {
    const fake = fakeShopify({ orders: ['5001'] });
    fake.userErrors.set('NaaradhOrderCancel', 'Order cannot be cancelled');
    await expect(applyOrderWriteback(client(fake), '5001', plan)).rejects.toBeInstanceOf(
      ShopifyUserError,
    );
    expect(fake.orders.get('gid://shopify/Order/5001')?.tags.has('naaradh:cod-cancelled')).toBe(
      true,
    );
    expect(fake.orders.get('gid://shopify/Order/5001')?.cancelledAt).toBeNull();
  });

  it('an order that does not exist is a user error, not a silent success', async () => {
    const fake = fakeShopify();
    await expect(cancelOrder(client(fake), '999', { staffNote: 'x' })).rejects.toBeInstanceOf(
      ShopifyUserError,
    );
  });

  it('metafields are single-line text in the naaradh namespace; bad keys and empty values are dropped', async () => {
    const fake = fakeShopify({ orders: ['5001'] });
    await applyOrderWriteback(client(fake), '5001', {
      tags: [],
      note: '',
      metafields: { ok_key: 'v', 'Bad-Key': 'x', empty: '' },
      cancelOrder: false,
    });
    expect(fake.calls).toEqual(['NaaradhMetafieldsSet']);
    const sent = fake.lastRequest?.body.variables['metafields'] as {
      key: string;
      type: string;
      namespace: string;
    }[];
    expect(sent).toEqual([
      {
        ownerId: 'gid://shopify/Order/5001',
        namespace: 'naaradh',
        key: 'ok_key',
        type: 'single_line_text_field',
        value: 'v',
      },
    ]);
  });

  it('order ids: numeric REST ids and GIDs are accepted; anything else is refused before a request', () => {
    expect(toOrderGid('5001')).toBe('gid://shopify/Order/5001');
    expect(toOrderGid('gid://shopify/Order/5001')).toBe('gid://shopify/Order/5001');
    expect(() => toOrderGid('#1001')).toThrow(ShopifyRequestError);
    expect(() => toOrderGid('B-77')).toThrow(ShopifyRequestError);
  });
});

describe('Shopify Flow trigger "Naaradh call completed" (P2-SHOP-7)', () => {
  const input = {
    orderId: '5001',
    outcome: 'confirmed',
    confidence: 0.9512,
    attempts: 1,
    needsReview: false,
  };

  it('carries the order and the outcome only — no phone, no transcript', async () => {
    const fake = fakeShopify({ orders: ['5001'] });
    await fireCallCompletedTrigger(client(fake), input);
    expect(fake.flowTriggers).toEqual([
      {
        handle: FLOW_TRIGGER_HANDLE,
        payload: {
          order_id: 5001,
          outcome: 'confirmed',
          confidence: 0.95,
          attempts: 1,
          needs_review: false,
        },
      },
    ]);
  });

  it('a refusal surfaces as a user error; a non-Shopify order ref fires nothing', async () => {
    const fake = fakeShopify({ orders: ['5001'] });
    fake.userErrors.set('NaaradhFlowTrigger', 'Invalid handle');
    await expect(fireCallCompletedTrigger(client(fake), input)).rejects.toBeInstanceOf(
      ShopifyUserError,
    );
    const quiet = fakeShopify({ orders: [] });
    await fireCallCompletedTrigger(client(quiet), { ...input, orderId: 'woo-77' });
    expect(quiet.flowTriggers).toEqual([]);
  });
});
