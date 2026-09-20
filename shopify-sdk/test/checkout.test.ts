import { describe, expect, it } from 'vitest';
import { FAKE_IN } from '../../shared/test/fake-phones.js';
import { CALL_CONSENT_ATTRIBUTE, parseShopifyCheckout } from '../src/webhooks.js';

/** checkouts/create|update (ADR-0010 §1–2, E-13, E-100, E-107). */

const base = {
  token: 'chk-token-1',
  created_at: '2026-09-15T10:00:00+05:30',
  updated_at: '2026-09-15T10:05:00+05:30',
  completed_at: null,
  currency: 'INR',
  total_price: '1499.50',
  source_name: 'web',
  line_items: [
    { title: 'Kurta', quantity: 2 },
    { title: 'Dupatta', quantity: 1 },
  ],
};

const parse = (over: Record<string, unknown>) => {
  const r = parseShopifyCheckout({ ...base, ...over });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('parseShopifyCheckout', () => {
  it('reads times, money, cart summary and the recipient country', () => {
    const c = parse({
      shipping_address: { phone: FAKE_IN.customer, country_code: 'IN', first_name: ' Asha ' },
    });
    expect(c.token).toBe('chk-token-1');
    expect(c.createdAt.toISOString()).toBe('2026-09-15T04:30:00.000Z');
    expect(c.totalMinor).toBe(149950);
    expect(c.currency).toBe('INR');
    expect(c.itemCount).toBe(3);
    expect(c.itemSummary).toBe('3 items');
    expect(parse({ line_items: [{ title: 'Kurta', quantity: 2 }] }).itemSummary).toBe('2 × Kurta');
    expect(c.countryCode).toBe('IN');
    expect(c.firstName).toBe('Asha');
    expect(c.completedAt).toBeNull();
  });

  it('phone: shipping, then checkout, then customer, then billing; blanks skipped (E-100)', () => {
    expect(parse({}).phone).toBeNull();
    expect(parse({ phone: '  ', customer: { phone: FAKE_IN.customerAlt } }).phone).toBe(
      FAKE_IN.customerAlt,
    );
    expect(
      parse({
        phone: FAKE_IN.customerAlt,
        shipping_address: { phone: FAKE_IN.customer },
        billing_address: { phone: FAKE_IN.optedOut },
      }).phone,
    ).toBe(FAKE_IN.customer);
    expect(parse({ billing_address: { phone: FAKE_IN.optedOut } }).phone).toBe(FAKE_IN.optedOut);
  });

  it('consent is only our attribute — trimmed, and empty means not ticked', () => {
    const attr = (value: string | null) => ({
      note_attributes: [{ name: CALL_CONSENT_ATTRIBUTE, value }],
    });
    expect(parse(attr(' 2026-09-v1-draft ')).consentAttribute).toBe('2026-09-v1-draft');
    expect(parse(attr('')).consentAttribute).toBeNull();
    expect(parse(attr(null)).consentAttribute).toBeNull();
    expect(
      parse({ note_attributes: [{ name: 'gift_note', value: 'yes' }] }).consentAttribute,
    ).toBeNull();
  });

  it('E-107: Shopify marketing consent is never read as call consent', () => {
    const c = parse({
      buyer_accepts_marketing: true,
      buyer_accepts_sms_marketing: true,
      sms_marketing_phone: FAKE_IN.customer,
      customer: { accepts_marketing: true, email_marketing_consent: { state: 'subscribed' } },
    });
    expect(c.consentAttribute).toBeNull();
  });

  it('never keeps the recovery URL, email or address', () => {
    const c = parse({
      abandoned_checkout_url: 'https://shop.example/checkouts/abc/recover?key=secret',
      email: 'someone@example.com',
      shipping_address: { phone: FAKE_IN.customer, address1: '1 Example Road', zip: '110001' },
    });
    const json = JSON.stringify(c);
    expect(json).not.toContain('recover');
    expect(json).not.toContain('example.com');
    expect(json).not.toContain('Example Road');
  });

  it('flags draft-order and POS checkouts, which nobody abandoned', () => {
    expect(parse({ source_name: 'shopify_draft_order' }).isDraftOrPos).toBe(true);
    expect(parse({ source_name: 'pos' }).isDraftOrPos).toBe(true);
    expect(parse({ source_name: 'web' }).isDraftOrPos).toBe(false);
  });

  it('reads completion and customer tags', () => {
    const c = parse({
      completed_at: '2026-09-15T10:20:00+05:30',
      customer: { tags: 'vip, staff ,' },
    });
    expect(c.completedAt?.toISOString()).toBe('2026-09-15T04:50:00.000Z');
    expect(c.customerTags).toEqual(['vip', 'staff']);
  });

  it('rejects a payload without a token or with a bad timestamp', () => {
    expect(parseShopifyCheckout({ ...base, token: '' }).ok).toBe(false);
    expect(parseShopifyCheckout({ ...base, updated_at: 'yesterday' }).ok).toBe(false);
  });
});
