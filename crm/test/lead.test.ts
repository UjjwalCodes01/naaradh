import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FAKE_IN, FAKE_US } from '@naaradh/shared/test/fake-phones';
import {
  CRM_SIGNATURE_HEADER,
  crmSharedSecret,
  crmWebhookPath,
  crmWebhookTag,
  parseLead,
  verifyCrmSignature,
  verifyCrmTag,
} from '../src/index.js';

const KEY = 'provider-webhook-key-at-least-32-chars';
const TENANT = 'ten_01HZX8Q9WJ4K7M2N5P6R8T9VWX';
const OTHER = 'ten_01HZX8Q9WJ4K7M2N5P6R8T9VWY';
const NOW = new Date('2026-09-26T10:00:00Z');

describe('the CRM webhook URL', () => {
  it('verifies a tag it minted, and nothing else', () => {
    expect(verifyCrmTag(KEY, 'zoho', `${TENANT}.${crmWebhookTag(KEY, 'zoho', TENANT)}`)).toEqual({
      provider: 'zoho',
      tenantId: TENANT,
    });
    // Another tenant's tag, another provider's tag, another area's tag: all refused.
    expect(verifyCrmTag(KEY, 'zoho', `${TENANT}.${crmWebhookTag(KEY, 'zoho', OTHER)}`)).toBeNull();
    expect(
      verifyCrmTag(KEY, 'hubspot', `${TENANT}.${crmWebhookTag(KEY, 'zoho', TENANT)}`),
    ).toBeNull();
    expect(verifyCrmTag(KEY, 'salesforce', `${TENANT}.x`)).toBeNull();
  });

  it('is a different URL from the same tenant’s one-click-checkout URL', async () => {
    // Both areas derive from one key; a leaked CRM URL must not be an OCC URL.
    const { occWebhookPath } = await import('@naaradh/occ');
    expect(crmWebhookPath(KEY, 'zoho', TENANT)).not.toBe(occWebhookPath(KEY, 'gokwik', TENANT));
    expect(crmSharedSecret(KEY, 'zoho', TENANT)).not.toBe(crmSharedSecret(KEY, 'hubspot', TENANT));
  });
});

describe('the optional signature', () => {
  const secret = crmSharedSecret(KEY, 'hubspot', TENANT);
  const raw = Buffer.from('{"phone":"x"}');

  it('accepts a correct hex or base64 signature', () => {
    for (const encoding of ['hex', 'base64'] as const)
      expect(
        verifyCrmSignature({
          secret,
          raw,
          signature: createHmac('sha256', secret).update(raw).digest(encoding),
          required: true,
        }),
      ).toEqual({ ok: true, signed: true });
  });

  it('refuses a present-but-wrong signature even when not required', () => {
    expect(verifyCrmSignature({ secret, raw, signature: 'deadbeef', required: false })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('accepts an unsigned body only when the merchant has not asked for signing', () => {
    expect(verifyCrmSignature({ secret, raw, signature: undefined, required: false })).toEqual({
      ok: true,
      signed: false,
    });
    expect(verifyCrmSignature({ secret, raw, signature: undefined, required: true })).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('names one header, so a merchant is told exactly what to add', () => {
    expect(CRM_SIGNATURE_HEADER).toBe('x-naaradh-signature');
  });
});

describe('reading a Zoho lead', () => {
  it('reads a workflow webhook with Zoho’s own field names', () => {
    const r = parseLead(
      'zoho',
      {
        id: '4876000000123001',
        First_Name: 'Ananya',
        Last_Name: 'Iyer',
        Phone: FAKE_IN.customer,
        Email: 'ananya@example.com',
        Company: 'Iyer Textiles',
        Lead_Source: 'Website form',
        Description: 'Wants a quote for 200 units',
        Country: 'IN',
      },
      undefined,
      NOW,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      provider: 'zoho',
      externalId: '4876000000123001',
      phone: FAKE_IN.customer,
      firstName: 'Ananya',
      email: 'ananya@example.com',
      company: 'Iyer Textiles',
      formName: 'Website form',
      topic: 'Wants a quote for 200 units',
      countryCode: 'IN',
      consentGiven: false,
    });
  });

  it('falls back to Mobile when Phone is empty', () => {
    const r = parseLead(
      'zoho',
      { id: '1', Phone: '', Mobile: FAKE_IN.customerAlt },
      undefined,
      NOW,
    );
    expect(r.ok && r.value.phone).toBe(FAKE_IN.customerAlt);
  });
});

describe('reading a HubSpot lead', () => {
  it('reads properties nested under `properties`, in HubSpot’s `{ value }` shape', () => {
    const r = parseLead(
      'hubspot',
      {
        objectId: 55_001,
        properties: {
          firstname: { value: 'Dan' },
          phone: { value: FAKE_US.customer },
          email: { value: 'dan@example.com' },
          message: { value: 'Please call about pricing' },
          country: { value: 'US' },
        },
      },
      undefined,
      NOW,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      provider: 'hubspot',
      externalId: '55001',
      firstName: 'Dan',
      phone: FAKE_US.customer,
      topic: 'Please call about pricing',
      countryCode: 'US',
    });
  });
});

describe('what a merchant can configure, and what they cannot', () => {
  it('uses the merchant’s own field names before the defaults', () => {
    const r = parseLead(
      'zoho',
      { lead_ref: 'L-9', Contact_Number: FAKE_IN.customer, Enquiry: 'Bulk order' },
      { id: ['lead_ref'], phone: ['Contact_Number'], topic: ['Enquiry'] },
      NOW,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      externalId: 'L-9',
      phone: FAKE_IN.customer,
      topic: 'Bulk order',
    });
  });

  it('records consent only when a mapped field actually says yes', () => {
    const lead = (consent: unknown) =>
      parseLead('hubspot', { objectId: 1, phone: FAKE_IN.customer, consent }, undefined, NOW);
    for (const yes of ['true', 'YES', 'granted', 'subscribed', '1'])
      expect(
        lead(yes).ok && (lead(yes) as { value: { consentGiven: boolean } }).value.consentGiven,
      ).toBe(true);
    for (const no of ['false', 'no', '', 'unknown', null])
      expect(
        lead(no).ok && (lead(no) as { value: { consentGiven: boolean } }).value.consentGiven,
      ).toBe(false);
  });

  it('refuses a lead with no phone, and says which field names it looked for', () => {
    const r = parseLead('zoho', { id: '1', Email: 'someone@example.com' }, undefined, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('phone');
    expect(r.error).toContain('Phone');
  });

  it('never invents an identity: no id falls back to the phone, not to a random value', () => {
    const a = parseLead('zoho', { Phone: FAKE_IN.customer }, undefined, NOW);
    const b = parseLead('zoho', { Phone: FAKE_IN.customer }, undefined, NOW);
    expect(a.ok && b.ok && a.value.externalId).toBe(b.ok ? b.value.externalId : '');
    // Same lead twice → same external ref → one intent, not two (E-42).
  });

  it('refuses a body that is not an object', () => {
    for (const body of ['a string', 42, null, []])
      expect(parseLead('zoho', body, undefined, NOW).ok).toBe(false);
  });
});
