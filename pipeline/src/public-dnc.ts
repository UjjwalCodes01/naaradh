import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '@naaradh/db';
import { DNC_REQUESTS_PER_PHONE_PER_DAY } from '@naaradh/compliance';
import { NaaradhError, hashPhone, newId, normalizePhone, type PhoneRegion } from '@naaradh/shared';

/**
 * The public do-not-call request (universal rule 8, P2-CMP-2), shared by the API endpoint
 * (`POST /v1/public/dnc`) and the page on naaradh.com. No tenant, no key: a GLOBAL, indefinite
 * suppression through `submit_dnc_request()` (migration 0007), optionally a complaint report.
 * The answer is identical whether or not the number was ever called — no oracle.
 *
 * Callers rate-limit per IP; the per-number daily limit is enforced here.
 */

export interface CounterStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export const DNC_CONFIRMATION =
  'This number will not be called by any business using Naaradh. It can take up to 24 hours to take effect everywhere.';

/** A keyed hash of the client IP, kept only for abuse investigation. */
export function ipHashOf(hashKey: string, ip: string): string {
  return createHmac('sha256', hashKey).update(`ip:${ip}`).digest('hex');
}

export async function submitDncRequest(
  db: Db,
  counters: CounterStore,
  input: {
    readonly hashKey: string;
    readonly phone: string;
    readonly region: string;
    readonly reportUnwantedCall: boolean;
    readonly ip: string;
    readonly now: Date;
  },
): Promise<void> {
  const parsed = normalizePhone(input.phone, input.region.toUpperCase() as PhoneRegion);
  if (!parsed.ok)
    throw new NaaradhError('VALIDATION_FAILED', 'phone is not a valid number', {
      context: { reason: parsed.reason },
    });
  const phoneHash = hashPhone(parsed.phone.e164, input.hashKey);
  const key = `dnc:${phoneHash}:${input.now.toISOString().slice(0, 10)}`;
  const n = await counters.incr(key);
  if (n === 1) await counters.expire(key, 2 * 86_400);
  if (n > DNC_REQUESTS_PER_PHONE_PER_DAY)
    throw new NaaradhError('RATE_LIMITED', 'too many requests for this number today', {
      retryAfterSec: 86_400,
    });
  await db.execute(sql`select submit_dnc_request(
    ${newId('suppression')}, ${newId('audit')}, ${newId('complaintReport')},
    ${phoneHash}, ${input.reportUnwantedCall}, ${ipHashOf(input.hashKey, input.ip)}
  )`);
}
