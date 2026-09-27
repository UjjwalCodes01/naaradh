'use server';

import { revalidatePath } from 'next/cache';
import { claimReferral } from '@naaradh/pipeline';
import { field, run, type ActionResult } from '@/lib/actions';
import { allow } from '@/lib/rate-limit';
import { now } from '@/lib/server';
import { actorOf, inTenant, requireSession } from '@/lib/session';

/**
 * "Who referred you?" — owners only, because it names a counterparty that may later be credited
 * (P7-GTM-1). Rate-limited so codes cannot be guessed from here: 10 tries an hour per account.
 */
export async function claimReferralCode(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('owner');
    if (!(await allow(`referral-claim:${s.tenantId}`, 10, 3600, { failClosed: true })))
      return { ok: false, message: 'Too many tries. Try again in an hour.' };
    const r = await inTenant(s, (tx) => claimReferral(tx, actorOf(s), field(form, 'code'), now()));
    revalidatePath('/app/referrals');
    return `Thank you — recorded that ${r.referrerName} referred you.`;
  });
}
