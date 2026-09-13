import { describe, expect, it } from 'vitest';
import { classifyGateway, isCodOrder } from '../src/gateways.js';
import { parseShopifyOrder } from '../src/webhooks.js';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';

describe('gateway normalisation table (E-45)', () => {
  it.each([
    ['Cash on Delivery (COD)', 'cod'],
    ['manual', 'cod'],
    ['GoKwik COD', 'cod'],
    ['GoKwik COD (Partial)', 'cod'],
    ['Shiprocket Checkout - COD', 'cod'],
    ['Razorpay', 'prepaid'],
    ['Razorpay Magic', 'prepaid'],
    ['shopify_payments', 'prepaid'],
    ['bogus', 'prepaid'],
    ['Some New Provider', 'unknown'],
    ['codfish payments', 'unknown'],
  ])('%s → %s', (label, expected) => {
    expect(classifyGateway(label)).toBe(expected);
  });

  it('an order is COD only when every gateway is COD and none is unknown', () => {
    expect(isCodOrder(['Cash on Delivery (COD)']).cod).toBe(true);
    expect(isCodOrder(['GoKwik COD']).cod).toBe(true);
    expect(isCodOrder(['Razorpay']).cod).toBe(false);
    expect(isCodOrder(['Cash on Delivery (COD)', 'Razorpay']).cod).toBe(false);
    expect(isCodOrder([]).cod).toBe(false);
    const unknown = isCodOrder(['Cash on Delivery (COD)', 'Mystery Pay']);
    expect(unknown.cod).toBe(false);
    expect(unknown.unknown).toEqual(['Mystery Pay']);
  });
});

describe('orders/create parsing', () => {
  const base = {
    id: 5001,
    name: '#1001',
    created_at: '2026-09-14T12:00:00+05:30',
    currency: 'INR',
    total_price: '499.00',
    payment_gateway_names: ['Cash on Delivery (COD)'],
    line_items: [{ title: 'Kurta', quantity: 2 }],
  };

  it('picks the shipping phone first and tolerates Level-2-redacted nulls', () => {
    const r = parseShopifyOrder({
      ...base,
      phone: null,
      customer: { first_name: 'Asha', last_name: null, phone: null },
      shipping_address: { phone: FAKE_IN.customer, zip: '110001' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.phone).toBe(FAKE_IN.customer);
      expect(r.value.customerName).toBe('Asha');
      expect(r.value.itemSummary).toBe('2 × Kurta');
    }
    const none = parseShopifyOrder({
      ...base,
      phone: null,
      customer: null,
      shipping_address: null,
    });
    if (none.ok) expect(none.value.phone).toBeNull();
    else expect.unreachable();
  });

  it('exposes test flag, tags and the consent attribute (E-13, E-46)', () => {
    const r = parseShopifyOrder({
      ...base,
      test: true,
      tags: 'vip, naaradh:skip',
      note_attributes: [{ name: 'naaradh_call_consent', value: 'yes:v1' }],
      customer: { tags: 'staff' },
    });
    if (!r.ok) expect.unreachable();
    else {
      expect(r.value.isTest).toBe(true);
      expect(r.value.tags).toEqual(['vip', 'naaradh:skip']);
      expect(r.value.customerTags).toEqual(['staff']);
      expect(r.value.callConsentAttribute).toBe('yes:v1');
    }
  });

  it('rejects malformed payloads instead of guessing', () => {
    expect(parseShopifyOrder({ ...base, created_at: 'yesterday' }).ok).toBe(false);
    expect(parseShopifyOrder({ ...base, total_price: 'free' }).ok).toBe(false);
  });
});

describe('order cache helpers (ADR-0006)', () => {
  it('payment kind comes from gateways, never financial_status', async () => {
    const { paymentKindOf } = await import('../src/gateways.js');
    expect(paymentKindOf(['Cash on Delivery (COD)'])).toBe('cod');
    expect(paymentKindOf(['razorpay'])).toBe('prepaid');
    expect(paymentKindOf(['razorpay', 'Cash on Delivery (COD)'])).toBe('unknown');
    expect(paymentKindOf([])).toBe('unknown');
    expect(paymentKindOf(['Some New Wallet'])).toBe('unknown');
  });

  it('fulfilments carry tracking and a status, nothing else', async () => {
    const { parseShopifyFulfillment } = await import('../src/webhooks.js');
    const r = parseShopifyFulfillment({
      id: 1,
      order_id: 551001,
      status: 'success',
      shipment_status: 'in_transit',
      tracking_company: 'Delhivery',
      tracking_numbers: ['DL123'],
      tracking_url: 'https://track.example/DL123',
      destination: { address1: 'must be ignored' },
    });
    expect(r.ok && r.value).toEqual({
      orderId: '551001',
      fulfillmentStatus: 'in_transit',
      tracking: {
        company: 'Delhivery',
        number: 'DL123',
        url: 'https://track.example/DL123',
        status: 'in_transit',
        estimatedDelivery: null,
      },
    });
    const cancelled = parseShopifyFulfillment({ id: 2, order_id: 9, status: 'cancelled' });
    expect(cancelled.ok && cancelled.value.fulfillmentStatus).toBeNull();
    expect(parseShopifyFulfillment({ id: 'x' }).ok).toBe(false);
  });
});
