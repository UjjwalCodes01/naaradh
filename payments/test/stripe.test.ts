import { describe, expect, it } from 'vitest';
import {
  STRIPE_API_VERSION,
  StripeError,
  StripeRetryableError,
  createStripeClient,
  formEncode,
  parseStripeEvent,
  signStripePayload,
  verifyStripeSignature,
} from '../src/stripe.js';

type Call = { url: string; method: string; body: string | null; headers: Record<string, string> };

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

const KEY = 'sk_test_0123456789abcdef';

describe('Stripe form encoding', () => {
  it('nests objects and arrays the way Stripe expects, skipping null/undefined', () => {
    expect(
      decodeURIComponent(
        formEncode({
          mode: 'subscription',
          line_items: [{ price: 'price_A', quantity: 1 }],
          metadata: { tenant_id: 'ten_x' },
          customer_email: undefined,
          skipped: null,
        }),
      ),
    ).toBe(
      'mode=subscription&line_items[0][price]=price_A&line_items[0][quantity]=1&metadata[tenant_id]=ten_x',
    );
  });

  it('escapes values, so a URL cannot smuggle in another field', () => {
    expect(formEncode({ success_url: 'https://x.test/?a=1&mode=payment' })).toBe(
      'success_url=https%3A%2F%2Fx.test%2F%3Fa%3D1%26mode%3Dpayment',
    );
  });
});

describe('Stripe client (P6-BILL-1)', () => {
  it('creates a subscription checkout: bearer auth, pinned version, idempotency key, tenant id', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          id: 'cs_test_abc',
          url: 'https://checkout.stripe.test/c/cs_test_abc',
          status: 'open',
          client_reference_id: 'ten_x',
        },
      },
    ]);
    const c = createStripeClient({ secretKey: KEY, fetchImpl: f.fetchImpl });
    const s = await c.createCheckoutSession({
      priceIds: ['price_G', 'price_IG'],
      tenantId: 'ten_x',
      successUrl: 'https://app.test/billing?checkout=done',
      cancelUrl: 'https://app.test/billing',
      idempotencyKey: 'checkout:ten_x:1',
    });
    expect(s).toEqual({
      id: 'cs_test_abc',
      url: 'https://checkout.stripe.test/c/cs_test_abc',
      status: 'open',
      subscriptionId: null,
      customerId: null,
      tenantId: 'ten_x',
    });
    const call = f.calls[0];
    expect(call).toMatchObject({
      url: 'https://api.stripe.com/v1/checkout/sessions',
      method: 'POST',
    });
    expect(call?.headers).toMatchObject({
      authorization: `Bearer ${KEY}`,
      'stripe-version': STRIPE_API_VERSION,
      'idempotency-key': 'checkout:ten_x:1',
      'content-type': 'application/x-www-form-urlencoded',
    });
    const sent = new URLSearchParams(call?.body ?? '');
    expect(sent.get('mode')).toBe('subscription');
    expect(sent.get('line_items[1][price]')).toBe('price_IG');
    expect(sent.get('client_reference_id')).toBe('ten_x');
    expect(sent.get('subscription_data[metadata][tenant_id]')).toBe('ten_x');
  });

  it('refuses an empty plan list without calling Stripe', async () => {
    const f = fakeFetch([]);
    const c = createStripeClient({ secretKey: KEY, fetchImpl: f.fetchImpl });
    await expect(
      c.createCheckoutSession({
        priceIds: [],
        tenantId: 'ten_x',
        successUrl: 'https://a.test',
        cancelUrl: 'https://a.test',
        idempotencyKey: 'k',
      }),
    ).rejects.toBeInstanceOf(StripeError);
    expect(f.calls).toHaveLength(0);
  });

  it('reads the period end from the subscription or, on newer versions, its items', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          id: 'sub_1',
          status: 'active',
          customer: 'cus_1',
          current_period_end: 1_790_000_000,
          currency: 'usd',
          metadata: { tenant_id: 'ten_x' },
        },
      },
      {
        status: 200,
        body: {
          id: 'sub_1',
          status: 'past_due',
          customer: { id: 'cus_1' },
          items: { data: [{ current_period_end: 1_790_000_000 }] },
        },
      },
    ]);
    const c = createStripeClient({ secretKey: KEY, fetchImpl: f.fetchImpl });
    const a = await c.retrieveSubscription('sub_1');
    const b = await c.retrieveSubscription('sub_1');
    expect(a).toMatchObject({
      status: 'active',
      customerId: 'cus_1',
      currency: 'USD',
      tenantId: 'ten_x',
    });
    expect(b).toMatchObject({ status: 'past_due', customerId: 'cus_1', tenantId: null });
    expect(a.currentPeriodEnd?.getTime()).toBe(1_790_000_000_000);
    expect(b.currentPeriodEnd).toEqual(a.currentPeriodEnd);
  });

  it('usage is an invoice item in whole cents, attached to the subscription', async () => {
    const f = fakeFetch([{ status: 200, body: { id: 'ii_1' } }]);
    const c = createStripeClient({ secretKey: KEY, fetchImpl: f.fetchImpl });
    const input = {
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      amountMinor: 12_345,
      currency: 'USD',
      description: 'Naaradh usage 2026-09',
      idempotencyKey: 'stripe:ten_x:2026-09',
    };
    expect(await c.createInvoiceItem(input)).toEqual({ id: 'ii_1' });
    const sent = new URLSearchParams(f.calls[0]?.body ?? '');
    expect(sent.get('amount')).toBe('12345');
    expect(sent.get('currency')).toBe('usd');
    expect(sent.get('subscription')).toBe('sub_1');
    expect(f.calls[0]?.headers['idempotency-key']).toBe('stripe:ten_x:2026-09');
    for (const bad of [0, -1, 1.5])
      await expect(c.createInvoiceItem({ ...input, amountMinor: bad })).rejects.toBeInstanceOf(
        StripeError,
      );
  });

  it('ids are checked before they reach a URL', async () => {
    const f = fakeFetch([]);
    const c = createStripeClient({ secretKey: KEY, fetchImpl: f.fetchImpl });
    await expect(c.retrieveSubscription('../customers')).rejects.toBeInstanceOf(StripeError);
    await expect(c.retrieveCheckoutSession('cs_x/../../')).rejects.toBeInstanceOf(StripeError);
    expect(f.calls).toHaveLength(0);
  });

  it('5xx/429/network are retryable; 4xx carries Stripe’s code', async () => {
    const f = fakeFetch([
      { status: 429, body: {} },
      { status: 502, body: {} },
      { status: 400, body: { error: { code: 'resource_missing', message: 'No such price' } } },
    ]);
    const c = createStripeClient({ secretKey: KEY, fetchImpl: f.fetchImpl });
    await expect(c.retrieveSubscription('sub_1')).rejects.toBeInstanceOf(StripeRetryableError);
    await expect(c.retrieveSubscription('sub_1')).rejects.toBeInstanceOf(StripeRetryableError);
    await expect(c.retrieveSubscription('sub_1')).rejects.toMatchObject({
      name: 'StripeError',
      status: 400,
      code: 'resource_missing',
    });
    const down = createStripeClient({
      secretKey: KEY,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(down.retrieveSubscription('sub_1')).rejects.toBeInstanceOf(StripeRetryableError);
  });
});

describe('Stripe webhooks (invariant 9)', () => {
  const secret = 'whsec_test_stripe';
  const T = 1_790_000_000;
  const body = Buffer.from(
    JSON.stringify({
      id: 'evt_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          object: 'subscription',
          status: 'past_due',
          customer_email: 'payer@example.test',
        },
      },
    }),
  );

  it('verifies t + v1 within five minutes; tampering, other secrets and replays are refused', () => {
    const header = signStripePayload(secret, body, T);
    expect(verifyStripeSignature(secret, body, header, T + 10)).toBe(true);
    expect(verifyStripeSignature(secret, Buffer.from(`${body.toString()} `), header, T)).toBe(
      false,
    );
    expect(verifyStripeSignature('whsec_other', body, header, T)).toBe(false);
    expect(verifyStripeSignature(secret, body, header, T + 301)).toBe(false);
    expect(verifyStripeSignature(secret, body, undefined, T)).toBe(false);
    expect(verifyStripeSignature(secret, body, 't=abc,v1=zz', T)).toBe(false);
  });

  it('while a secret is rolled, any of several v1 signatures verifies', () => {
    const old = signStripePayload('whsec_old', body, T).split(',')[1];
    const current = signStripePayload(secret, body, T);
    expect(verifyStripeSignature(secret, body, `${current},${String(old)}`, T)).toBe(true);
    expect(verifyStripeSignature(secret, body, `t=${String(T)},${String(old)}`, T)).toBe(false);
  });

  it('parses a verified event down to ids — never the payer’s details', () => {
    expect(parseStripeEvent(body)).toEqual({
      id: 'evt_1',
      type: 'customer.subscription.updated',
      subscriptionId: 'sub_1',
      checkoutSessionId: null,
    });
    const checkout = Buffer.from(
      JSON.stringify({
        id: 'evt_2',
        type: 'checkout.session.completed',
        data: {
          object: { id: 'cs_test_abc', object: 'checkout.session', subscription: 'sub_2' },
        },
      }),
    );
    expect(parseStripeEvent(checkout)).toEqual({
      id: 'evt_2',
      type: 'checkout.session.completed',
      subscriptionId: 'sub_2',
      checkoutSessionId: 'cs_test_abc',
    });
    expect(parseStripeEvent(Buffer.from('not json'))).toBeNull();
    expect(parseStripeEvent(Buffer.from('{"type":"x"}'))).toBeNull();
  });
});
