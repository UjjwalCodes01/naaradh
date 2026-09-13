import { eq, sql } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import { VERIFY_MAX_FAILURES, type Identity } from '@naaradh/compliance';
import { orderByRef, pincodeMatches } from './orders.js';

/**
 * Caller verification (AGENTS §5.8). State lives on the attempt row, written only here — the
 * model can ask to verify, it cannot declare itself verified.
 */

export interface AttemptIdentity {
  readonly attemptId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly callerHash: string | null;
  readonly identity: Identity;
  readonly verifiedOrderIds: readonly string[];
  readonly verifyFailures: number;
}

/**
 * On an OUTBOUND call we dialled the customer's number ourselves, so the person on the line is
 * reached through that number: at least `caller_id` for orders on it. Inbound starts from
 * whatever admission established.
 */
export function effectiveIdentity(a: AttemptIdentity): Identity {
  if (a.direction === 'outbound' && a.identity === 'none') return 'caller_id';
  return a.identity;
}

export type VerifyResult =
  | { readonly ok: true; readonly orderId: string }
  | { readonly ok: false; readonly locked: boolean; readonly failures: number };

export async function verifyCaller(
  tx: DbOrTx,
  hashKey: string,
  tenantId: string,
  attempt: AttemptIdentity,
  orderRef: string,
  pincode: string,
  at: Date,
): Promise<VerifyResult> {
  if (attempt.verifyFailures >= VERIFY_MAX_FAILURES)
    return { ok: false, locked: true, failures: attempt.verifyFailures };

  const order = await orderByRef(tx, tenantId, orderRef);
  // Always run the hash comparison, even with no order, so timing does not reveal which factor failed.
  const matched = pincodeMatches(hashKey, pincode, order?.pincodeHash ?? null) && order !== null;

  if (matched) {
    await tx
      .update(schema.callAttempts)
      .set({
        callerVerification: 'knowledge',
        callerVerifiedAt: at,
        verifiedOrderIds: sql`(select array(select distinct unnest(${schema.callAttempts.verifiedOrderIds} || array[${order.id}]::text[])))`,
      })
      .where(eq(schema.callAttempts.id, attempt.attemptId));
    return { ok: true, orderId: order.id };
  }

  const failures = attempt.verifyFailures + 1;
  await tx
    .update(schema.callAttempts)
    .set({ verifyFailures: failures })
    .where(eq(schema.callAttempts.id, attempt.attemptId));
  return { ok: false, locked: failures >= VERIFY_MAX_FAILURES, failures };
}
