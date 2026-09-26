import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGNATURE_POLICY,
  effectiveSignaturePolicy,
  occSharedSecret,
  occWebhookPath,
  occWebhookTag,
  verifyOccSignature,
  verifyOccTag,
  type OccProvider,
} from '../src/index.js';

const KEY = 'occ-webhook-key-at-least-32-characters-long';
const TENANT = 'ten_01HZX8Q9WJ4K7M2N5P6R8T9VWX';
const OTHER_TENANT = 'ten_01HZX8Q9WJ4K7M2N5P6R8T9VWY';
const BODY = Buffer.from(JSON.stringify({ cart_id: 'c_1', total_price: '1499.00' }));

describe('the one-click-checkout URL tag', () => {
  it('mints a path that names the provider and the tenant', () => {
    expect(occWebhookPath(KEY, 'cashfree', TENANT)).toBe(
      `/occ/cashfree/${TENANT}.${occWebhookTag(KEY, 'cashfree', TENANT)}`,
    );
  });

  it('verifies a tag it minted', () => {
    const tag = occWebhookTag(KEY, 'gokwik', TENANT);
    expect(verifyOccTag(KEY, 'gokwik', `${TENANT}.${tag}`)).toEqual({
      provider: 'gokwik',
      tenantId: TENANT,
    });
  });

  it("refuses another tenant's tag on this tenant's URL", () => {
    const tag = occWebhookTag(KEY, 'gokwik', OTHER_TENANT);
    expect(verifyOccTag(KEY, 'gokwik', `${TENANT}.${tag}`)).toBeNull();
  });

  it('refuses a tag minted for a different provider', () => {
    // Otherwise one provider's leaked URL would work for all four.
    const tag = occWebhookTag(KEY, 'cashfree', TENANT);
    expect(verifyOccTag(KEY, 'gokwik', `${TENANT}.${tag}`)).toBeNull();
  });

  it('refuses a tag minted with a different key', () => {
    const tag = occWebhookTag('another-key-that-is-also-32-characters', 'cashfree', TENANT);
    expect(verifyOccTag(KEY, 'cashfree', `${TENANT}.${tag}`)).toBeNull();
  });

  it('refuses an unknown provider, a malformed tenant id and a missing tag', () => {
    expect(
      verifyOccTag(KEY, 'stripe', `${TENANT}.${occWebhookTag(KEY, 'cashfree', TENANT)}`),
    ).toBeNull();
    expect(
      verifyOccTag(KEY, 'cashfree', `not-a-tenant.${occWebhookTag(KEY, 'cashfree', TENANT)}`),
    ).toBeNull();
    expect(verifyOccTag(KEY, 'cashfree', TENANT)).toBeNull();
    expect(verifyOccTag(KEY, 'cashfree', '')).toBeNull();
    expect(verifyOccTag(KEY, 'cashfree', `.${occWebhookTag(KEY, 'cashfree', TENANT)}`)).toBeNull();
  });

  it('derives a different shared secret per provider and tenant, and never the tag itself', () => {
    const a = occSharedSecret(KEY, 'cashfree', TENANT);
    expect(a).not.toBe(occSharedSecret(KEY, 'gokwik', TENANT));
    expect(a).not.toBe(occSharedSecret(KEY, 'cashfree', OTHER_TENANT));
    expect(a).not.toContain(occWebhookTag(KEY, 'cashfree', TENANT));
  });
});

describe('the provider signature', () => {
  const now = new Date('2026-09-26T10:00:00Z');
  const secret = occSharedSecret(KEY, 'cashfree', TENANT);
  const cashfreeSignature = (ts: string, body = BODY, key = secret): string =>
    createHmac('sha256', key).update(ts).update(body).digest('base64');

  it('accepts Cashfree’s documented scheme: base64 hmac over timestamp + body', () => {
    const ts = String(Math.floor(now.getTime() / 1000));
    expect(
      verifyOccSignature({
        provider: 'cashfree',
        secret,
        raw: BODY,
        signature: cashfreeSignature(ts),
        timestamp: ts,
        policy: 'required',
        now,
      }),
    ).toEqual({ ok: true, signed: true });
  });

  it('rejects a Cashfree signature over a different body (tampering)', () => {
    const ts = String(Math.floor(now.getTime() / 1000));
    expect(
      verifyOccSignature({
        provider: 'cashfree',
        secret,
        raw: Buffer.from(JSON.stringify({ cart_id: 'c_1', total_price: '1.00' })),
        signature: cashfreeSignature(ts),
        timestamp: ts,
        policy: 'required',
        now,
      }),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a replay outside the window, even with a valid signature', () => {
    const stale = String(Math.floor(now.getTime() / 1000) - 3600);
    expect(
      verifyOccSignature({
        provider: 'cashfree',
        secret,
        raw: BODY,
        signature: cashfreeSignature(stale),
        timestamp: stale,
        policy: 'required',
        now,
      }),
    ).toEqual({ ok: false, reason: 'stale' });
  });

  it('rejects a Cashfree delivery with no timestamp to bind the signature to', () => {
    expect(
      verifyOccSignature({
        provider: 'cashfree',
        secret,
        raw: BODY,
        signature: cashfreeSignature('1758880800'),
        timestamp: undefined,
        policy: 'required',
        now,
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a missing signature where the provider is known to sign', () => {
    expect(DEFAULT_SIGNATURE_POLICY.cashfree).toBe('required');
    expect(
      verifyOccSignature({
        provider: 'cashfree',
        secret,
        raw: BODY,
        signature: undefined,
        timestamp: undefined,
        policy: 'required',
        now,
      }),
    ).toEqual({ ok: false, reason: 'missing' });
  });

  it('accepts no signature only where the provider publishes no scheme', () => {
    for (const provider of ['gokwik', 'shiprocket', 'razorpay_magic'] as const) {
      expect(DEFAULT_SIGNATURE_POLICY[provider]).toBe('optional');
      expect(
        verifyOccSignature({
          provider,
          secret,
          raw: BODY,
          signature: undefined,
          timestamp: undefined,
          policy: DEFAULT_SIGNATURE_POLICY[provider],
          now,
        }),
      ).toEqual({ ok: true, signed: false });
    }
  });

  it('never accepts a signature that is present and wrong, whatever the policy', () => {
    // The downgrade that must not exist: sending a bogus header must fail, not fall back to
    // "unsigned is allowed here".
    for (const provider of ['gokwik', 'shiprocket', 'razorpay_magic', 'cashfree'] as const) {
      for (const policy of ['optional', 'required'] as const) {
        const verdict = verifyOccSignature({
          provider,
          secret,
          raw: BODY,
          signature: 'deadbeef',
          timestamp: String(Math.floor(now.getTime() / 1000)),
          policy,
          now,
        });
        expect(verdict.ok, `${provider}/${policy}`).toBe(false);
      }
    }
  });

  it('accepts hex or base64 for the providers whose encoding is unconfirmed', () => {
    const digest = createHmac('sha256', secret).update(BODY).digest();
    for (const provider of ['gokwik', 'shiprocket'] as const satisfies readonly OccProvider[]) {
      for (const encoding of ['hex', 'base64'] as const) {
        expect(
          verifyOccSignature({
            provider,
            secret,
            raw: BODY,
            signature: digest.toString(encoding),
            timestamp: undefined,
            policy: 'required',
            now,
          }),
        ).toEqual({ ok: true, signed: true });
      }
    }
  });
});

describe('configuration can tighten verification, never weaken it', () => {
  it('keeps Cashfree signed however the integration is configured', () => {
    // The downgrade this prevents: a dashboard field (or anyone who can write that row) setting
    // 'optional' on the one provider that publishes a signing scheme, leaving the URL as the
    // only credential.
    for (const configured of ['optional', 'required', undefined, null, 'nonsense', 1, {}])
      expect(effectiveSignaturePolicy('cashfree', configured)).toBe('required');
  });

  it('lets a merchant require signatures from a provider that does not publish a scheme', () => {
    for (const provider of ['gokwik', 'shiprocket', 'razorpay_magic'] as const) {
      expect(effectiveSignaturePolicy(provider, 'required')).toBe('required');
      expect(effectiveSignaturePolicy(provider, 'optional')).toBe('optional');
      // Unset or unreadable falls back to the provider's default, never to "off".
      expect(effectiveSignaturePolicy(provider, undefined)).toBe(
        DEFAULT_SIGNATURE_POLICY[provider],
      );
      expect(effectiveSignaturePolicy(provider, 'nonsense')).toBe(
        DEFAULT_SIGNATURE_POLICY[provider],
      );
    }
  });
});
