import { redis } from './server';

/**
 * Fixed-window counters in Redis. Returns false once `limit` is exceeded within the window.
 * Fails OPEN on a Redis outage for reads of the dashboard, but callers that guard abuse-prone
 * public actions (sign-in links, the do-not-call page) pass `failClosed`.
 */
export async function allow(
  key: string,
  limit: number,
  windowSec: number,
  options: { readonly failClosed?: boolean } = {},
): Promise<boolean> {
  try {
    const bucket = Math.floor(Date.now() / 1000 / windowSec);
    const k = `rl:web:${key}:${String(bucket)}`;
    const n = await redis().incr(k);
    if (n === 1) await redis().expire(k, windowSec * 2);
    return n <= limit;
  } catch {
    return options.failClosed !== true;
  }
}
