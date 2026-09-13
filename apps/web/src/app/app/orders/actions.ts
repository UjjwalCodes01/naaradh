'use server';

import { revalidatePath } from 'next/cache';
import { openDispute } from '@naaradh/pipeline';
import { field, run, type ActionResult } from '@/lib/actions';
import { now } from '@/lib/server';
import { actorOf, inTenant, requireSession } from '@/lib/session';

/** E-62: dispute a billed outcome within 7 days; Naaradh staff review it with the evidence. */
export async function disputeOutcome(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    const outcomeId = field(form, 'outcome_id');
    await inTenant(s, (tx) =>
      openDispute(tx, {
        tenantId: s.tenantId,
        outcomeId,
        reason: field(form, 'reason'),
        openedBy: actorOf(s).id,
        actorType: 'user',
        at: now(),
      }),
    );
    revalidatePath(`/app/orders/${field(form, 'intent_id')}`);
    return 'Dispute opened. We review the recording and call details and reply within 3 business days.';
  });
}
