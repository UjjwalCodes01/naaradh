import { headers } from 'next/headers';
import { ipHashOf } from '@naaradh/pipeline';
import { env } from './env';

/**
 * The client IP behind Google's load balancer. GCLB appends `<client-ip>, <lb-ip>` to whatever
 * X-Forwarded-For the client sent, so the trustworthy entry is the second from the end; anything
 * before it is client-controlled. Locally there is no LB and the header may be absent.
 */
export function clientIpFrom(xff: string | null): string {
  const parts = (xff ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length >= 2) return parts[parts.length - 2] ?? 'unknown';
  return parts[0] ?? 'unknown';
}

export async function clientIp(): Promise<string> {
  return clientIpFrom((await headers()).get('x-forwarded-for'));
}

export async function clientIpHash(): Promise<string> {
  return ipHashOf(env().PHONE_HASH_KEY, await clientIp());
}

export async function userAgent(): Promise<string | null> {
  return (await headers()).get('user-agent')?.slice(0, 200) ?? null;
}
