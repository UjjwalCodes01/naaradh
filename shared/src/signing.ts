import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto';

/**
 * Signature helpers for every boundary (invariant 9). All comparisons are constant-time.
 */

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Outbound merchant webhooks (AGENTS §8):
//   X-Naaradh-Signature: t=<unix>,v1=<hmac_sha256(secret, t + '.' + body)>
// ---------------------------------------------------------------------------

export const WEBHOOK_REPLAY_WINDOW_SEC = 300;

export function signMerchantWebhook(secret: string, body: string, unixSeconds: number): string {
  const v1 = createHmac('sha256', secret)
    .update(`${String(unixSeconds)}.${body}`)
    .digest('hex');
  return `t=${String(unixSeconds)},v1=${v1}`;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'expired' | 'mismatch' };

/**
 * Verifies a merchant-webhook signature header against the raw body. `nowUnix` is injected
 * so tests can walk the clock past the replay window.
 */
export function verifyMerchantWebhook(
  secret: string,
  header: string | undefined,
  body: string,
  nowUnix: number,
  toleranceSec = WEBHOOK_REPLAY_WINDOW_SEC,
): VerifyResult {
  if (header === undefined) return { ok: false, reason: 'malformed' };
  const parts = Object.fromEntries(
    header.split(',').map((kv) => kv.split('=', 2) as [string, string]),
  );
  const t = Number(parts['t']);
  const v1 = parts['v1'];
  if (!Number.isFinite(t) || v1 === undefined) return { ok: false, reason: 'malformed' };
  if (Math.abs(nowUnix - t) > toleranceSec) return { ok: false, reason: 'expired' };
  const expected = createHmac('sha256', secret)
    .update(`${String(t)}.${body}`)
    .digest('hex');
  return timingSafeEqualString(expected, v1) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

// ---------------------------------------------------------------------------
// Tenant-bound webhook URLs for a third party that cannot sign, or whose scheme we do not know:
//   https://hooks.naaradh.com/<area>/<provider>/<tenant_id>.<tag>
//
// The tag is the credential. It is minted from one server-side key, it names exactly one tenant
// and one provider, and it is checked in constant time before the body is parsed (invariant 9),
// so a payload cannot be replayed into another merchant's context and a leaked URL for one
// provider does not work for another. Where the provider does sign, that signature is checked on
// top — this replaces nothing, it is the floor.
// ---------------------------------------------------------------------------

/** `HMAC(key, "<area>:<provider>:<tenant_id>")`, truncated to 128 bits. */
export function providerWebhookTag(
  key: string,
  area: string,
  provider: string,
  tenantId: string,
): string {
  return createHmac('sha256', key)
    .update(`${area}:${provider}:${tenantId}`)
    .digest('hex')
    .slice(0, 32);
}

export function providerWebhookPath(
  key: string,
  area: string,
  provider: string,
  tenantId: string,
): string {
  return `/${area}/${provider}/${tenantId}.${providerWebhookTag(key, area, provider, tenantId)}`;
}

/** Parses `<tenant_id>.<tag>` and verifies it. Null on any mismatch — the route 404s. */
export function verifyProviderWebhookTag(
  key: string,
  area: string,
  provider: string,
  tenantTag: string,
): string | null {
  const dot = tenantTag.lastIndexOf('.');
  if (dot <= 0) return null;
  const tenantId = tenantTag.slice(0, dot);
  const tag = tenantTag.slice(dot + 1);
  if (!/^ten_[0-9A-HJKMNP-TV-Z]{26}$/.test(tenantId) || tag.length !== 32) return null;
  return timingSafeEqualString(providerWebhookTag(key, area, provider, tenantId), tag)
    ? tenantId
    : null;
}

/**
 * The secret a merchant pastes into the provider's dashboard. Derived from the same key and
 * never stored, so there is no per-tenant secret in the database and rotating the key rotates
 * every merchant's URL and secret together. Domain-separated from the tag: neither reveals the
 * other.
 */
export function providerSharedSecret(
  key: string,
  area: string,
  provider: string,
  tenantId: string,
): string {
  return createHmac('sha256', key).update(`${area}-secret:${provider}:${tenantId}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Engine webhook URLs: https://hooks.naaradh.com/engine/<vendor>/<tenant_id>.<tag>
// The tag binds the URL to one tenant so a vendor payload cannot be replayed into another
// tenant's context; the vendor's own signature (verified by the adapter) proves origin.
// ---------------------------------------------------------------------------

export function engineWebhookTag(key: string, vendor: string, tenantId: string): string {
  return createHmac('sha256', key).update(`${vendor}:${tenantId}`).digest('hex').slice(0, 32);
}

export function engineWebhookPath(key: string, vendor: string, tenantId: string): string {
  return `/engine/${vendor}/${tenantId}.${engineWebhookTag(key, vendor, tenantId)}`;
}

/** Parses `<tenant_id>.<tag>` and verifies the tag. Null on any mismatch — the route 404s. */
export function verifyEngineWebhookTag(
  key: string,
  vendor: string,
  tenantTag: string,
): string | null {
  const dot = tenantTag.lastIndexOf('.');
  if (dot <= 0) return null;
  const tenantId = tenantTag.slice(0, dot);
  const tag = tenantTag.slice(dot + 1);
  if (!/^ten_[0-9A-HJKMNP-TV-Z]{26}$/.test(tenantId) || tag.length !== 32) return null;
  return timingSafeEqualString(engineWebhookTag(key, vendor, tenantId), tag) ? tenantId : null;
}

// ---------------------------------------------------------------------------
// Shopify: X-Shopify-Hmac-Sha256 = base64(hmac_sha256(app_secret, raw_body))
// ---------------------------------------------------------------------------

export function verifyShopifyHmac(
  appSecret: string,
  rawBody: Buffer,
  headerValue: string | undefined,
): boolean {
  if (headerValue === undefined || headerValue.length === 0) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('base64');
  return timingSafeEqualString(expected, headerValue);
}

// ---------------------------------------------------------------------------
// API keys (E-70). `nrd_live_<32 base62>` / `nrd_test_…` / `nrd_pk_…`. Only the SHA-256 of
// the full key is stored; `prefix` (12 chars) is for display and support lookups.
// ---------------------------------------------------------------------------

export type ApiKeyEnv = 'live' | 'test' | 'pk';

export interface GeneratedApiKey {
  readonly key: string;
  readonly keyHash: string;
  readonly prefix: string;
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateApiKey(env: ApiKeyEnv): GeneratedApiKey {
  const bytes = randomBytes(32);
  let body = '';
  for (const b of bytes) body += BASE62.charAt(b % 62);
  const key = `nrd_${env}_${body}`;
  return { key, keyHash: hashApiKey(key), prefix: key.slice(0, 12) };
}

export function hashApiKey(key: string): string {
  return sha256Hex(key);
}

export function parseApiKeyEnv(key: string): ApiKeyEnv | null {
  const m = /^nrd_(live|test|pk)_[A-Za-z0-9]{32}$/.exec(key);
  return m === null ? null : (m[1] as ApiKeyEnv);
}

// ---------------------------------------------------------------------------
// Voice tool URLs: https://voice.naaradh.com/tools/<vendor>/<tenant_id>.<tag>/<tool>
// Same construction as engine webhook URLs but a separate tag domain ('voice:'), so a hooks
// URL can never be replayed against a tool endpoint or the other way round.
// ---------------------------------------------------------------------------

export function voiceToolPath(key: string, vendor: string, tenantId: string, tool: string): string {
  return `/tools/${vendor}/${tenantId}.${engineWebhookTag(key, `voice:${vendor}`, tenantId)}/${tool}`;
}

export function verifyVoiceToolTag(key: string, vendor: string, tenantTag: string): string | null {
  return verifyEngineWebhookTag(key, `voice:${vendor}`, tenantTag);
}

// ---------------------------------------------------------------------------
// Inbound lookups from engines that tell us who is calling but not which number was dialled:
//   https://voice.naaradh.com/inbound/<vendor>?called=<our E.164>&tag=<hmac>
// We build this URL when a number is attached to the engine, so the called number — the only
// source of the tenant (invariant 16) — is ours and cannot be swapped by whoever calls the URL.
// A separate tag domain ('inbound:'), so no other signed URL can be replayed here.
// ---------------------------------------------------------------------------

export function inboundLookupPath(key: string, vendor: string, e164: string): string {
  const tag = engineWebhookTag(key, `inbound:${vendor}`, e164);
  return `/inbound/${vendor}?called=${encodeURIComponent(e164)}&tag=${tag}`;
}

/** The bound number when `called` + `tag` verify; null otherwise. */
export function verifyInboundLookup(
  key: string,
  vendor: string,
  called: string | undefined,
  tag: string | undefined,
): string | null {
  if (called === undefined || tag === undefined || tag.length !== 32) return null;
  // A `+` in a query string decodes to a space.
  const e164 = called.trim().replace(/^(?=\d)/, '+');
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return null;
  return timingSafeEqualString(engineWebhookTag(key, `inbound:${vendor}`, e164), tag) ? e164 : null;
}

// ---------------------------------------------------------------------------
// Region directory snapshots (ADR-0012 amendment 1): Ed25519, one key pair per region.
//   X-Naaradh-Region:    the sender's region
//   X-Naaradh-Signature: t=<unix>,sig=<base64url(ed25519(t + '.' + body))>
// Each region holds only its own private key and its peers' PUBLIC keys, so no peer (and no
// holder of a peer's config) can sign as another region — a shared HMAC key could not do that.
// ---------------------------------------------------------------------------

/** A new region key pair: the private key as base64 PKCS#8 DER, the public key as base64 raw. */
export function generateRegionKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: Buffer.from(jwk.x ?? '', 'base64url').toString('base64'),
  };
}

export function signRegionSnapshot(
  privateKeyB64: string,
  body: string,
  unixSeconds: number,
): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const sig = cryptoSign(null, Buffer.from(`${String(unixSeconds)}.${body}`), key);
  return `t=${String(unixSeconds)},sig=${sig.toString('base64url')}`;
}

export function verifyRegionSnapshot(
  publicKeyB64: string,
  header: string | undefined,
  body: string,
  nowUnix: number,
  toleranceSec = WEBHOOK_REPLAY_WINDOW_SEC,
): VerifyResult {
  if (header === undefined) return { ok: false, reason: 'malformed' };
  const parts = Object.fromEntries(
    header.split(',').map((kv) => kv.split('=', 2) as [string, string]),
  );
  const t = Number(parts['t']);
  const sig = parts['sig'];
  if (!Number.isInteger(t) || sig === undefined || !/^[A-Za-z0-9_-]+$/.test(sig))
    return { ok: false, reason: 'malformed' };
  if (Math.abs(nowUnix - t) > toleranceSec) return { ok: false, reason: 'expired' };
  let key;
  try {
    key = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(publicKeyB64, 'base64').toString('base64url'),
      },
      format: 'jwk',
    });
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const ok = cryptoVerify(
    null,
    Buffer.from(`${String(t)}.${body}`),
    key,
    Buffer.from(sig, 'base64url'),
  );
  return ok ? { ok: true } : { ok: false, reason: 'mismatch' };
}
