'use server';

import { revalidatePath } from 'next/cache';
import { approveScript } from '@naaradh/pipeline';
import { field, run, type ActionResult } from '@/lib/actions';
import { now } from '@/lib/server';
import { actorOf, inTenant, requireSession } from '@/lib/session';

export async function approveScriptAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    await inTenant(s, (tx) => approveScript(tx, actorOf(s), s.role, field(form, 'id'), now()));
    revalidatePath('/app/scripts');
    return 'Approved — new calls use this version.';
  });
}
