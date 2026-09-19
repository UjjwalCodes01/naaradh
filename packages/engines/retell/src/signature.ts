import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Retell signs every webhook and every custom-function request with the account's API key
 * (invariant 9): `x-retell-signature: v=<unix ms>,d=<hex HMAC-SHA256(api_key, raw_body + ms)>`.
 * [VERIFY] against a recorded delivery — this is the scheme of Retell's published SDKs
 * (`Retell.verify`). A signature older or newer than five minutes is refused (replay).
 */

export const RETELL_SIGNATURE_HEADER = 'x-retell-signature';
const TOLERANCE_MS = 5 * 60_000;

function digest(apiKey: string, rawBody: Buffer, timestamp: string): Buffer {
  return createHmac('sha256', apiKey)
    .update(Buffer.concat([rawBody, Buffer.from(timestamp, 'utf8')]))
    .digest();
}

export function signRetell(apiKey: string, rawBody: Buffer, nowMs: number): string {
  return `v=${String(nowMs)},d=${digest(apiKey, rawBody, String(nowMs)).toString('hex')}`;
}

export function verifyRetell(
  apiKey: string,
  rawBody: Buffer,
  header: string | undefined,
  nowMs: number,
): boolean {
  if (header === undefined) return false;
  const m = /^v=(\d{10,16}),d=([0-9a-f]{64})$/.exec(header.trim());
  if (m === null) return false;
  const ts = m[1] ?? '';
  if (Math.abs(nowMs - Number(ts)) > TOLERANCE_MS) return false;
  const expected = digest(apiKey, rawBody, ts);
  const given = Buffer.from(m[2] ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
