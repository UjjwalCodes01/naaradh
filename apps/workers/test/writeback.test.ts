import { describe, expect, it } from 'vitest';
import { ShopifyRetryableError } from '@naaradh/shopify-sdk';
import { fakeShopify } from '../../../packages/shopify-sdk/test/fake-shopify.js';
import { inlineSecretResolver } from '../src/deliveries/secrets.js';
import {
  StoreNotConnectedError,
  isRetryableWritebackError,
  shopifyWriteback,
} from '../src/results/shopify-writeback.js';
import { planWriteback, type WritebackInput } from '../src/results/writeback.js';

const input = (o: Partial<WritebackInput> = {}): WritebackInput => ({
  outcome: 'confirmed',
  confidence: 0.95,
  attempts: 1,
  outcomeId: 'out_x',
  lastCallAt: new Date('2026-09-14T06:30:00Z'),
  summary: 'confirmed',
  addressChange: null,
  tenant: { autoCancelEnabled: false, addressWriteEnabled: false },
  ...o,
});

describe('planWriteback — invariant 14 / E-44', () => {
  it('writeback.cancel_requires_setting_and_confidence — a cancelled outcome cancels only with auto-cancel on AND confidence ≥ 0.9', () => {
    expect(planWriteback(input({ outcome: 'cancelled' })).cancelOrder).toBe(false);
    expect(
      planWriteback(
        input({
          outcome: 'cancelled',
          tenant: { autoCancelEnabled: true, addressWriteEnabled: false },
          confidence: 0.89,
        }),
      ).cancelOrder,
    ).toBe(false);
    const ok = planWriteback(
      input({
        outcome: 'cancelled',
        tenant: { autoCancelEnabled: true, addressWriteEnabled: false },
      }),
    );
    expect(ok.cancelOrder).toBe(true);
    const review = planWriteback(input({ outcome: 'cancelled' }));
    expect(review.tags).toContain('naaradh:cancel-review');
  });

  it('writeback.address_requires_confidence — an address change is ALWAYS review, even with the setting on and confidence 1.0 (Q-19)', () => {
    const p = planWriteback(
      input({
        addressChange: 'Flat 2, New Road',
        confidence: 1,
        tenant: { autoCancelEnabled: true, addressWriteEnabled: true },
      }),
    );
    expect(p.needsReview).toBe(true);
    expect(p.tags).toContain('naaradh:address-review');
    expect(p.tags).not.toContain('naaradh:address-updated');
    // The free-text address never reaches Shopify: not in the note, not in a metafield.
    expect(JSON.stringify(p)).not.toContain('New Road');
  });

  it('only non-confirmation outcomes count attempts in tags; a blank address is not a change', () => {
    expect(planWriteback(input({ outcome: 'no_answer', attempts: 2 })).tags).toEqual([
      'naaradh:no-answer',
      'naaradh:no-answer-2',
    ]);
    expect(planWriteback(input({ addressChange: '   ' })).needsReview).toBe(false);
  });
});

describe('shopifyWriteback — the production port', () => {
  const plan = planWriteback(
    input({
      outcome: 'cancelled',
      tenant: { autoCancelEnabled: true, addressWriteEnabled: false },
    }),
  );

  it('resolves the token from the integration secret ref and writes every merged order (E-42)', async () => {
    const fake = fakeShopify({ orders: ['5001', '5002'] });
    const port = shopifyWriteback({
      secrets: inlineSecretResolver(),
      apiVersion: '2026-07',
      fetchImpl: fake.fetch,
    });
    await port.apply(
      'ten_x',
      { shopDomain: 'client-a-dev.myshopify.com', credentialsSecretRef: 'inline:shpat_test' },
      ['5001', '5002'],
      plan,
    );
    for (const id of ['5001', '5002']) {
      expect(fake.orders.get(`gid://shopify/Order/${id}`)?.cancelledAt).not.toBeNull();
      expect(
        fake.orders.get(`gid://shopify/Order/${id}`)?.metafields.get('naaradh.outcome_ref'),
      ).toBe('out_x');
    }
  });

  it('a store with no credentials is not retried — it needs a person to reconnect', async () => {
    const port = shopifyWriteback({
      secrets: inlineSecretResolver(),
      apiVersion: '2026-07',
      fetchImpl: fakeShopify().fetch,
    });
    const error = await port
      .apply(
        'ten_x',
        { shopDomain: 'client-a-dev.myshopify.com', credentialsSecretRef: null },
        ['5001'],
        plan,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreNotConnectedError);
    expect(isRetryableWritebackError(error)).toBe(false);
  });

  it('classifies failures: transient → retry; auth, refusal, bad request → stop', async () => {
    expect(isRetryableWritebackError(new ShopifyRetryableError('503'))).toBe(true);
    expect(isRetryableWritebackError(new Error('socket hang up'))).toBe(true);
    const fake = fakeShopify({ orders: ['5001'], token: 'someone_else' });
    const port = shopifyWriteback({
      secrets: inlineSecretResolver(),
      apiVersion: '2026-07',
      fetchImpl: fake.fetch,
    });
    const auth = await port
      .apply(
        'ten_x',
        { shopDomain: 'client-a-dev.myshopify.com', credentialsSecretRef: 'inline:shpat_test' },
        ['5001'],
        plan,
      )
      .catch((e: unknown) => e);
    expect(isRetryableWritebackError(auth)).toBe(false);
    const refused = fakeShopify({ orders: ['5001'] });
    refused.userErrors.set('NaaradhOrderCancel', 'Order cannot be cancelled');
    const port2 = shopifyWriteback({
      secrets: inlineSecretResolver(),
      apiVersion: '2026-07',
      fetchImpl: refused.fetch,
    });
    const userError = await port2
      .apply(
        'ten_x',
        { shopDomain: 'client-a-dev.myshopify.com', credentialsSecretRef: 'inline:shpat_test' },
        ['5001'],
        plan,
      )
      .catch((e: unknown) => e);
    expect(isRetryableWritebackError(userError)).toBe(false);
  });
});
