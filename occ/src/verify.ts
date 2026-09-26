/**
 * Authenticating a one-click-checkout webhook (invariant 9: verified before parsed).
 *
 * Two independent layers, because these four providers do not agree on signing:
 *
 *  1. **The URL tag — always.** Each merchant gets
 *     `https://hooks.naaradh.com/occ/<provider>/<tenant_id>.<tag>`, where the tag is
 *     `HMAC-SHA256(PROVIDER_WEBHOOK_KEY, 'occ:<provider>:<tenant_id>')`. Only we can mint it, it
 *     binds the body to exactly one tenant (so one merchant's provider cannot post carts into
 *     another's), and it is checked in constant time before the body is read. This mirrors the
 *     engine webhook tag (`engineWebhookPath`, `@naaradh/shared`), which has the same job.
 *
 *  2. **The provider's signature — where the provider has one.** Cashfree signs
 *     (`x-webhook-signature` over `timestamp + body`, with a secret specific to the abandoned
 *     checkout webhook) and Razorpay signs its payment webhooks the same way it always does.
 *     GoKwik and Shiprocket publish no scheme. So the policy is per integration:
 *     `required` rejects a missing signature, `optional` accepts the URL tag alone but still
 *     rejects a signature that is present and wrong — a wrong signature is always an attack or a
 *     misconfiguration, never something to shrug at.
 *
 * The shared secret a merchant pastes into the provider's dashboard is derived from the same key
 * (`occSharedSecret`), so there is no per-tenant secret to store, and rotating `PROVIDER_WEBHOOK_KEY`
 * rotates every merchant's URL and secret together (docs/runbooks/secret-rotation.md).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { verifyRazorpaySignature } from '@naaradh/payments';
import {
  WEBHOOK_REPLAY_WINDOW_SEC,
  providerSharedSecret,
  providerWebhookPath,
  providerWebhookTag,
  timingSafeEqualString,
  verifyProviderWebhookTag,
} from '@naaradh/shared';
import { isOccProvider, type OccProvider } from './types.js';

/** The URL area these providers post to, and the domain separator in every derived value. */
const AREA = 'occ';

/** How strict to be about the provider's own signature, per integration. */
export type SignaturePolicy = 'required' | 'optional';

/**
 * Cashfree documents a signature, so an integration with it defaults to `required`; the other
 * three default to `optional` until their scheme is confirmed (`[VERIFY]`). A merchant can
 * tighten any of them from the dashboard (`integrations.metadata.occ.signature`) but never
 * loosen one below its default — see `effectiveSignaturePolicy`.
 */
export const DEFAULT_SIGNATURE_POLICY: Readonly<Record<OccProvider, SignaturePolicy>> = {
  cashfree: 'required',
  razorpay_magic: 'optional',
  gokwik: 'optional',
  shiprocket: 'optional',
};

/**
 * The policy actually applied: the stricter of what the merchant configured and what the
 * provider's own scheme demands.
 *
 * Configuration may tighten verification, never weaken it. A provider that publishes a signing
 * scheme is always verified against it, whatever is stored on the integration — otherwise a
 * mis-set dashboard field (or anyone who can write that row) could turn cryptographic
 * verification off and leave the webhook URL as the only credential, which is exactly the
 * downgrade invariant 9 exists to prevent.
 */
export function effectiveSignaturePolicy(
  provider: OccProvider,
  configured: unknown,
): SignaturePolicy {
  const fallback = DEFAULT_SIGNATURE_POLICY[provider];
  if (fallback === 'required') return 'required';
  return configured === 'required' ? 'required' : fallback;
}

// ---------------------------------------------------------------------------
// The URL tag
// ---------------------------------------------------------------------------

export function occWebhookTag(key: string, provider: OccProvider, tenantId: string): string {
  return providerWebhookTag(key, AREA, provider, tenantId);
}

export function occWebhookPath(key: string, provider: OccProvider, tenantId: string): string {
  return providerWebhookPath(key, AREA, provider, tenantId);
}

/** Parses `<tenant_id>.<tag>` and verifies the tag. Null on any mismatch — the route 404s. */
export function verifyOccTag(
  key: string,
  provider: string,
  tenantTag: string,
): { readonly provider: OccProvider; readonly tenantId: string } | null {
  if (!isOccProvider(provider)) return null;
  const tenantId = verifyProviderWebhookTag(key, AREA, provider, tenantTag);
  return tenantId === null ? null : { provider, tenantId };
}

/**
 * The secret the merchant pastes into the provider's dashboard. Derived, never stored, and
 * different per provider and tenant, so one merchant's secret says nothing about another's.
 */
export function occSharedSecret(key: string, provider: OccProvider, tenantId: string): string {
  return providerSharedSecret(key, AREA, provider, tenantId);
}

// ---------------------------------------------------------------------------
// The provider's signature
// ---------------------------------------------------------------------------

export type SignatureVerdict =
  /** Verified, or legitimately absent under an `optional` policy. */
  | { readonly ok: true; readonly signed: boolean }
  | { readonly ok: false; readonly reason: 'missing' | 'invalid' | 'stale' | 'malformed' };

export interface SignatureInput {
  readonly provider: OccProvider;
  readonly secret: string;
  readonly raw: Buffer;
  readonly signature: string | undefined;
  readonly timestamp: string | undefined;
  readonly policy: SignaturePolicy;
  readonly now: Date;
}

export function verifyOccSignature(input: SignatureInput): SignatureVerdict {
  const present = input.signature !== undefined && input.signature.length > 0;
  if (!present)
    return input.policy === 'required'
      ? { ok: false, reason: 'missing' }
      : { ok: true, signed: false };

  switch (input.provider) {
    case 'cashfree':
      return verifyCashfree(input);
    // Razorpay's scheme for every webhook it does sign: hex HMAC-SHA256 of the raw body.
    case 'razorpay_magic':
      return verifyRazorpaySignature(input.secret, input.raw, input.signature)
        ? { ok: true, signed: true }
        : { ok: false, reason: 'invalid' };
    // [VERIFY] GoKwik and Shiprocket publish no scheme. Hex HMAC-SHA256 over the raw body is
    // what both are reported to send, and it is the only thing we accept: an unrecognised
    // signature is never treated as "no signature".
    case 'gokwik':
    case 'shiprocket':
      return hmacHexMatches(input.secret, input.raw, input.signature)
        ? { ok: true, signed: true }
        : { ok: false, reason: 'invalid' };
  }
}

/**
 * Cashfree: `base64(HMAC-SHA256(secret, timestamp + rawBody))` with the timestamp from
 * `x-webhook-timestamp` (Unix, seconds or milliseconds). Signing the timestamp is what makes the
 * freshness check meaningful, so a missing or stale timestamp is a rejection, not a warning.
 * `[VERIFY]` — the abandoned-checkout page states the header and the separate secret but not the
 * algorithm; this is Cashfree's documented scheme for its other webhooks.
 */
function verifyCashfree(input: SignatureInput): SignatureVerdict {
  const ts = (input.timestamp ?? '').trim();
  if (!/^\d{10,13}$/.test(ts)) return { ok: false, reason: 'malformed' };
  const seconds = ts.length > 10 ? Math.floor(Number(ts) / 1000) : Number(ts);
  const skew = Math.abs(Math.floor(input.now.getTime() / 1000) - seconds);
  if (skew > WEBHOOK_REPLAY_WINDOW_SEC) return { ok: false, reason: 'stale' };
  const expected = createHmac('sha256', input.secret).update(ts).update(input.raw).digest('base64');
  return timingSafeEqualString(expected, input.signature ?? '')
    ? { ok: true, signed: true }
    : { ok: false, reason: 'invalid' };
}

function hmacHexMatches(secret: string, raw: Buffer, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(raw).digest();
  // Accept hex or base64 so a provider's choice of encoding is not a production incident.
  for (const encoding of ['hex', 'base64'] as const) {
    const candidate = Buffer.from(signature.trim(), encoding);
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

/** The header each provider puts its signature and timestamp in. */
export const SIGNATURE_HEADERS: Readonly<
  Record<OccProvider, { readonly signature: string; readonly timestamp?: string }>
> = {
  cashfree: { signature: 'x-webhook-signature', timestamp: 'x-webhook-timestamp' },
  razorpay_magic: { signature: 'x-razorpay-signature' },
  gokwik: { signature: 'x-gokwik-signature' },
  shiprocket: { signature: 'x-shiprocket-signature' },
};
