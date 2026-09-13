import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

/**
 * Identity-Aware Proxy JWT verification (`x-goog-iap-jwt-assertion`). IAP signs with ES256;
 * keys are published at https://www.gstatic.com/iap/verify/public_key-jwk. Checked: signature,
 * alg, `iss`, `aud` (this backend service), `exp`/`iat` with 30 s skew. The email claim is the
 * staff identity — never a header a client could set.
 */

export const IAP_ISSUER = 'https://cloud.google.com/iap';
export const IAP_JWK_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';

export interface StaffIdentity {
  readonly email: string;
}

export type KeyFetcher = () => Promise<ReadonlyMap<string, KeyObject>>;

export function iapKeyFetcher(fetchImpl: typeof fetch = fetch, ttlMs = 60 * 60_000): KeyFetcher {
  let cached: { at: number; keys: Map<string, KeyObject> } | null = null;
  return async () => {
    if (cached !== null && Date.now() - cached.at < ttlMs) return cached.keys;
    const res = await fetchImpl(IAP_JWK_URL, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`IAP key fetch failed: HTTP ${String(res.status)}`);
    const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    const keys = new Map<string, KeyObject>();
    for (const k of body.keys ?? [])
      if (typeof k.kid === 'string') keys.set(k.kid, createPublicKey({ key: k, format: 'jwk' }));
    cached = { at: Date.now(), keys };
    return keys;
  };
}

function b64json(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export async function verifyIapJwt(
  token: string | undefined,
  audience: string,
  keys: KeyFetcher,
  nowMs: number = Date.now(),
): Promise<StaffIdentity | null> {
  if (token === undefined) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = b64json(h);
    payload = b64json(p);
  } catch {
    return null;
  }
  if (header['alg'] !== 'ES256' || typeof header['kid'] !== 'string') return null;
  const key = (await keys()).get(header['kid']);
  if (key === undefined) return null;
  const ok = verify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  );
  if (!ok) return null;
  const now = Math.floor(nowMs / 1000);
  if (payload['iss'] !== IAP_ISSUER || payload['aud'] !== audience) return null;
  if (typeof payload['exp'] !== 'number' || payload['exp'] < now - 30) return null;
  if (typeof payload['iat'] !== 'number' || payload['iat'] > now + 30) return null;
  const email = payload['email'];
  if (typeof email !== 'string' || !email.includes('@')) return null;
  return { email: email.replace(/^accounts\.google\.com:/, '').toLowerCase() };
}

export function isStaff(
  email: string,
  allowedDomain: string,
  allowList: readonly string[],
): boolean {
  const e = email.toLowerCase();
  if (allowList.includes(e)) return true;
  return allowedDomain !== '' && e.endsWith(`@${allowedDomain.toLowerCase()}`);
}
