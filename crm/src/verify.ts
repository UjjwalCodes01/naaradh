/**
 * Authenticating a CRM lead webhook (invariant 9: verified before parsed).
 *
 * Neither CRM signs a workflow webhook in a way we can verify per merchant: Zoho's workflow
 * webhook sends no signature at all, and HubSpot's signature is computed from the **app's** client
 * secret, which a merchant using a private app or a workflow action does not share with us. So
 * the per-tenant URL is the credential — minted from `PROVIDER_WEBHOOK_KEY`, naming exactly one
 * tenant and one provider, checked in constant time before the body is read
 * (`@naaradh/shared` `providerWebhookTag`, the same scheme the engine and one-click-checkout URLs
 * use).
 *
 * On top of that, a merchant who *can* add a header gets a real signature: send
 * `x-naaradh-signature` as hex or base64 HMAC-SHA256 of the raw body, keyed with the secret shown
 * beside the URL. A signature that is present and wrong is always refused — never treated as
 * "unsigned is allowed here".
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  providerSharedSecret,
  providerWebhookPath,
  providerWebhookTag,
  verifyProviderWebhookTag,
} from '@naaradh/shared';
import { isCrmProvider, type CrmProvider } from './types.js';

const AREA = 'crm';

/** The header a merchant can add if their CRM allows custom headers. */
export const CRM_SIGNATURE_HEADER = 'x-naaradh-signature';

export function crmWebhookTag(key: string, provider: CrmProvider, tenantId: string): string {
  return providerWebhookTag(key, AREA, provider, tenantId);
}

export function crmWebhookPath(key: string, provider: CrmProvider, tenantId: string): string {
  return providerWebhookPath(key, AREA, provider, tenantId);
}

export function crmSharedSecret(key: string, provider: CrmProvider, tenantId: string): string {
  return providerSharedSecret(key, AREA, provider, tenantId);
}

/** Parses `<tenant_id>.<tag>`. Null on any mismatch — the route 404s, with no oracle. */
export function verifyCrmTag(
  key: string,
  provider: string,
  tenantTag: string,
): { readonly provider: CrmProvider; readonly tenantId: string } | null {
  if (!isCrmProvider(provider)) return null;
  const tenantId = verifyProviderWebhookTag(key, AREA, provider, tenantTag);
  return tenantId === null ? null : { provider, tenantId };
}

export type CrmSignatureVerdict =
  | { readonly ok: true; readonly signed: boolean }
  | { readonly ok: false; readonly reason: 'missing' | 'invalid' };

/**
 * `required` is opt-in per integration (`metadata.crm.signature`), for a merchant whose CRM can
 * send the header. It can only ever tighten: there is no configuration that turns a present
 * signature into an unchecked one.
 */
export function verifyCrmSignature(input: {
  readonly secret: string;
  readonly raw: Buffer;
  readonly signature: string | undefined;
  readonly required: boolean;
}): CrmSignatureVerdict {
  if (input.signature === undefined || input.signature.length === 0)
    return input.required ? { ok: false, reason: 'missing' } : { ok: true, signed: false };

  const expected = createHmac('sha256', input.secret).update(input.raw).digest();
  for (const encoding of ['hex', 'base64'] as const) {
    const candidate = Buffer.from(input.signature.trim(), encoding);
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected))
      return { ok: true, signed: true };
  }
  return { ok: false, reason: 'invalid' };
}
