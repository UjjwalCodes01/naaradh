import { describe, expect, it } from 'vitest';
import { FAKE_IN, FAKE_UK } from '@naaradh/shared/test/fake-phones';
import { decimalToMinor, itemSummaryOf, parseOccCheckout } from '../src/index.js';

const RECEIVED = new Date('2026-09-26T10:00:00Z');

describe('decimalToMinor', () => {
  it('reads a provider money string exactly', () => {
    expect(decimalToMinor('1499')).toBe(149900);
    expect(decimalToMinor('1499.50')).toBe(149950);
    expect(decimalToMinor('1,499.50')).toBe(149950);
    expect(decimalToMinor('0.05')).toBe(5);
    expect(decimalToMinor('.5')).toBe(50);
    expect(decimalToMinor(1499.5)).toBe(149950);
    // Three decimals: rounded like a provider's own total, never truncated silently.
    expect(decimalToMinor('10.005')).toBe(1001);
    expect(decimalToMinor('10.004')).toBe(1000);
  });

  it('is 0 for anything unreadable rather than NaN', () => {
    for (const value of [null, undefined, '', 'free', 'â‚¹1499'])
      expect(decimalToMinor(value)).toBe(0);
  });

  it('does not drift the way a float multiply does', () => {
    // Number('8.29') * 100 === 828.9999999999999
    expect(decimalToMinor('8.29')).toBe(829);
    expect(decimalToMinor('1.005')).toBe(101);
  });
});

describe('itemSummaryOf', () => {
  it('reads back quantities and caps the list', () => {
    expect(
      itemSummaryOf([
        { name: 'Blue kurta', quantity: 2 },
        { name: 'Silk scarf', quantity: 1 },
      ]),
    ).toBe('2 × Blue kurta, Silk scarf');
    expect(
      itemSummaryOf([
        { name: 'A', quantity: 1 },
        { name: 'B', quantity: 1 },
        { name: 'C', quantity: 1 },
        { name: 'D', quantity: 1 },
        { name: 'E', quantity: 1 },
      ]),
    ).toBe('A, B, C and 2 more');
  });

  it('is empty when nothing has a name', () => {
    expect(
      itemSummaryOf([
        { name: null, quantity: 1 },
        { name: '  ', quantity: 2 },
      ]),
    ).toBe('');
  });
});

describe('Cashfree OCC', () => {
  const body = {
    type: 'ABANDONED_CHECKOUT',
    event_time: '2026-09-26T09:55:00Z',
    data: {
      cart_id: 'cart_9001',
      cart_token: 'tok_9001',
      store_url: 'https://shop.example',
      abandoned_checkout_url: 'https://shop.example/cart/tok_9001',
      total_price: '2499.50',
      original_total_price: '2799.00',
      currency: 'INR',
      phone: FAKE_IN.customer,
      customer: {
        email: 'shopper@example.com',
        first_name: 'Asha',
        last_name: 'Rao',
        shipping_address: { country_code: 'IN', phone: FAKE_IN.customerAlt },
      },
      line_items: [
        { sku_name: 'Blue kurta', quantity: 2 },
        { name: 'Silk scarf', quantity: 1 },
      ],
      created_at: '2026-09-26T09:40:00Z',
      updated_at: '2026-09-26T09:55:00Z',
    },
  };

  it('maps the documented payload to a cart', () => {
    const r = parseOccCheckout('cashfree', body, RECEIVED);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      provider: 'cashfree',
      externalId: 'cart_9001',
      currency: 'INR',
      totalMinor: 249950,
      phone: FAKE_IN.customer,
      countryCode: 'IN',
      firstName: 'Asha',
      itemSummary: '2 × Blue kurta, Silk scarf',
      itemCount: 3,
      completedAt: null,
      isDraftOrPos: false,
      consentAttribute: null,
    });
    expect(r.value.createdAt.toISOString()).toBe('2026-09-26T09:40:00.000Z');
    expect(r.value.updatedAt.toISOString()).toBe('2026-09-26T09:55:00.000Z');
  });

  it('treats a cart that became an order as completed, so nobody is called', () => {
    const r = parseOccCheckout(
      'cashfree',
      { ...body, data: { ...body.data, order_id: 'ord_1' } },
      RECEIVED,
    );
    expect(r.ok && r.value.completedAt).not.toBeNull();
  });

  it('records an early cart with no contact details yet', () => {
    const { phone, customer, ...rest } = body.data;
    expect(phone).toBeDefined();
    expect(customer).toBeDefined();
    const r = parseOccCheckout('cashfree', { ...body, data: rest }, RECEIVED);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No phone means the cart is kept but can never be dialled.
    expect(r.value.phone).toBeNull();
    expect(r.value.firstName).toBeNull();
  });

  it('refuses a body with no cart id, naming the field', () => {
    const r = parseOccCheckout('cashfree', { ...body, data: { total_price: '10' } }, RECEIVED);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('cart_id');
  });

  it('ignores another Cashfree event type', () => {
    const r = parseOccCheckout('cashfree', { ...body, type: 'PAYMENT_SUCCESS' }, RECEIVED);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('unhandled type');
  });
});

describe('Razorpay Magic', () => {
  const body = {
    shop_id: 'shop_1',
    platform: 'shopify',
    token: 'tk_1',
    cart_token: 'ct_77',
    email: 'shopper@example.com',
    phone: FAKE_IN.customer,
    abandoned_checkout_url: 'https://shop.example/cart/ct_77',
    currency: 'INR',
    line_items: [{ name: 'Running shoes', quantity: 1 }],
    line_items_total: '3999',
    customer: {
      first_name: 'Vikram',
      shipping_address: { country_code: 'IN' },
    },
  };

  it('maps the documented payload, preferring the cart token as identity', () => {
    const r = parseOccCheckout('razorpay_magic', body, RECEIVED);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      provider: 'razorpay_magic',
      externalId: 'ct_77',
      totalMinor: 399900,
      phone: FAKE_IN.customer,
      firstName: 'Vikram',
      itemCount: 1,
    });
  });

  it('falls back to the phone on the customer when the top level has none', () => {
    const { phone, ...rest } = body;
    expect(phone).toBeDefined();
    const r = parseOccCheckout(
      'razorpay_magic',
      { ...rest, customer: { ...body.customer, contact: FAKE_UK.customer } },
      RECEIVED,
    );
    expect(r.ok && r.value.phone).toBe(FAKE_UK.customer);
  });
});

describe('GoKwik and Shiprocket (tolerant until a payload is recorded)', () => {
  it('reads a nested body with its own key spellings', () => {
    const r = parseOccCheckout(
      'gokwik',
      {
        event: 'cart.abandoned',
        event_id: 'evt_5',
        data: {
          checkout_id: 88_001,
          mobile: FAKE_IN.customer,
          customer_name: 'Meera',
          cart_value: '1,250.75',
          items: [{ product_name: 'Cotton saree', quantity: 1 }],
          shipping_address: { country: 'IN' },
          recovery_url: 'https://shop.example/r/88001',
        },
      },
      RECEIVED,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      provider: 'gokwik',
      externalId: '88001',
      phone: FAKE_IN.customer,
      firstName: 'Meera',
      totalMinor: 125075,
      countryCode: 'IN',
      eventId: 'evt_5',
      itemSummary: 'Cotton saree',
    });
  });

  it('reads a flat Shopify-shaped body', () => {
    const r = parseOccCheckout(
      'shiprocket',
      {
        cart_token: 'sr_1',
        phone: FAKE_IN.customerAlt,
        total_price: '500',
        line_items: [{ title: 'Mug', quantity: 4 }],
      },
      RECEIVED,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      provider: 'shiprocket',
      externalId: 'sr_1',
      itemCount: 4,
      totalMinor: 50000,
    });
  });

  it('treats an order event as completed', () => {
    const r = parseOccCheckout(
      'shiprocket',
      { event: 'order.created', data: { cart_token: 'sr_2', phone: FAKE_IN.customer } },
      RECEIVED,
    );
    expect(r.ok && r.value.completedAt).not.toBeNull();
  });

  it('refuses a body with no recognisable cart id', () => {
    const r = parseOccCheckout('gokwik', { mobile: FAKE_IN.customer }, RECEIVED);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('cart id');
  });

  it('never invents a phone number', () => {
    const r = parseOccCheckout('gokwik', { cart_id: 'x', customer: {} }, RECEIVED);
    expect(r.ok && r.value.phone).toBeNull();
  });

  it('falls back to the arrival time for an unreadable timestamp, so the cart still expires', () => {
    const r = parseOccCheckout('gokwik', { cart_id: 'x', created_at: 'sometime' }, RECEIVED);
    expect(r.ok && r.value.createdAt.toISOString()).toBe(RECEIVED.toISOString());
  });
});
