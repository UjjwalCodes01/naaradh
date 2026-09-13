'use server';

import { revalidatePath } from 'next/cache';
import { resolveTicket, startTicket } from '@naaradh/pipeline';
import { field, run, type ActionResult } from '@/lib/actions';
import { now } from '@/lib/server';
import { actorOf, inTenant, requireSession } from '@/lib/session';

export async function startTicketAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('operator');
    await inTenant(s, (tx) => startTicket(tx, actorOf(s), field(form, 'id')));
    revalidatePath('/app/tickets');
    return 'Marked in progress.';
  });
}

export async function resolveTicketAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('operator');
    await inTenant(s, (tx) =>
      resolveTicket(tx, actorOf(s), field(form, 'id'), field(form, 'resolution'), now()),
    );
    revalidatePath('/app/tickets');
    return 'Resolved.';
  });
}
