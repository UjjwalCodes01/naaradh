import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RazorpayError,
  RazorpayRetryableError,
  createRazorpayClient,
  parseRazorpaySubscriptionEvent,
  verifyRazorpaySignature,
} from '../src/razorpay.js';

type Call = { url: string; method: string; body: unknown; auth: string | null };

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      auth: headers['authorization'] ?? null,
    });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

const sub = {
  id: 'sub_ABC123',
  plan_id: 'plan_G1',
  status: 'created',
  short_url: 'https://rzp.io/i/xyz',
  current_end: null,
  notes: { tenant_id: 'ten_x' },
};

describe('Razorpay client (P2-BILL-3)', () => {
  it('creates a subscription with basic auth, JSON body, our tenant id in notes', async () => {
    const f = fakeFetch([{ status: 200, body: sub }]);
    const c = createRazorpayClient({
      keyId: 'rzp_test_key',
      keySecret: 'secret',
      fetchImpl: f.fetchImpl,
    });
    const r = await c.createSubscription({ planId: 'plan_G1', notes: { tenant_id: 'ten_x' } });
    expect(r).toMatchObject({
      id: 'sub_ABC123',
      status: 'created',
      shortUrl: 'https://rzp.io/i/xyz',
      notes: { tenant_id: 'ten_x' },
    });
    expect(f.calls[0]).toMatchObject({
      url: 'https://api.razorpay.com/v1/subscriptions',
      method: 'POST',
    });
    expect(f.calls[0]?.auth).toBe(`Basic ${Buffer.from('rzp_test_key:secret').toString('base64')}`);
    expect(f.calls[0]?.body).toEqual({
      plan_id: 'plan_G1',
      total_count: 120,
      customer_notify: 1,
      notes: { tenant_id: 'ten_x' },
    });
  });

  it('adds usage as an add-on in paise, quantity 1', async () => {
    const f = fakeFetch([{ status: 200, body: { id: 'ao_1' } }]);
    const c = createRazorpayClient({ keyId: 'k', keySecret: 's', fetchImpl: f.fetchImpl });
    expect(
      await c.createAddon('sub_ABC123', {
        name: 'Naaradh usage',
        amountMinor: 12_000,
        currency: 'INR',
      }),
    ).toEqual({ id: 'ao_1' });
    expect(f.calls[0]).toMatchObject({
      url: 'https://api.razorpay.com/v1/subscriptions/sub_ABC123/addons',
      body: { item: { name: 'Naaradh usage', amount: 12_000, currency: 'INR' }, quantity: 1 },
    });
    await expect(
      c.createAddon('sub_ABC123', { name: 'x', amountMinor: 0, currency: 'INR' }),
    ).rejects.toBeInstanceOf(RazorpayError);
    await expect(
      c.createAddon('../../etc', { name: 'x', amountMinor: 1, currency: 'INR' }),
    ).rejects.toBeInstanceOf(RazorpayError);
  });

  it('5xx/429/network are retryable; 4xx carries Razorpay’s code', async () => {
    const f = fakeFetch([
      { status: 503, body: {} },
      {
        status: 400,
        body: { error: { code: 'BAD_REQUEST_ERROR', description: 'plan does not exist' } },
      },
    ]);
    const c = createRazorpayClient({ keyId: 'k', keySecret: 's', fetchImpl: f.fetchImpl });
    await expect(c.fetchSubscription('sub_ABC123')).rejects.toBeInstanceOf(RazorpayRetryableError);
    await expect(c.fetchSubscription('sub_ABC123')).rejects.toMatchObject({
      name: 'RazorpayError',
      code: 'BAD_REQUEST_ERROR',
      status: 400,
    });
    const down = createRazorpayClient({
      keyId: 'k',
      keySecret: 's',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(down.fetchSubscription('sub_ABC123')).rejects.toBeInstanceOf(
      RazorpayRetryableError,
    );
  });

  it('cancels at cycle end when asked', async () => {
    const f = fakeFetch([{ status: 200, body: { ...sub, status: 'cancelled' } }]);
    const c = createRazorpayClient({ keyId: 'k', keySecret: 's', fetchImpl: f.fetchImpl });
    expect((await c.cancelSubscription('sub_ABC123', true)).status).toBe('cancelled');
    expect(f.calls[0]?.body).toEqual({ cancel_at_cycle_end: 1 });
  });
});

describe('Razorpay webhooks (invariant 9)', () => {
  const secret = 'whsec_test_razorpay';
  const body = Buffer.from(
    JSON.stringify({
      entity: 'event',
      event: 'subscription.halted',
      payload: {
        subscription: {
          entity: {
            id: 'sub_ABC123',
            plan_id: 'plan_G1',
            status: 'halted',
            notes: { tenant_id: 'ten_x' },
          },
        },
      },
    }),
  );
  const sig = createHmac('sha256', secret).update(body).digest('hex');

  it('verifies the hex HMAC of the raw body, constant-time; anything else is refused', () => {
    expect(verifyRazorpaySignature(secret, body, sig)).toBe(true);
    expect(verifyRazorpaySignature(secret, Buffer.from(`${body.toString()} `), sig)).toBe(false);
    expect(verifyRazorpaySignature('other', body, sig)).toBe(false);
    expect(verifyRazorpaySignature(secret, body, undefined)).toBe(false);
    expect(verifyRazorpaySignature(secret, body, 'not-hex')).toBe(false);
  });

  it('parses subscription events only; empty notes arrive as []', () => {
    expect(parseRazorpaySubscriptionEvent(body)).toEqual({
      event: 'subscription.halted',
      subscriptionId: 'sub_ABC123',
      status: 'halted',
      tenantId: 'ten_x',
    });
    expect(
      parseRazorpaySubscriptionEvent(
        Buffer.from(JSON.stringify({ event: 'payment.captured', payload: {} })),
      ),
    ).toBeNull();
    const noNotes = Buffer.from(
      JSON.stringify({
        event: 'subscription.activated',
        payload: { subscription: { entity: { id: 'sub_1', status: 'active', notes: [] } } },
      }),
    );
    expect(parseRazorpaySubscriptionEvent(noNotes)?.tenantId).toBeNull();
    expect(parseRazorpaySubscriptionEvent(Buffer.from('not json'))).toBeNull();
  });
});
