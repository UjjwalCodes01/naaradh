'use server';

import { revalidatePath } from 'next/cache';
import { approveScript, endAbTest, startAbTest } from '@naaradh/pipeline';
import { field, optionalField, run, type ActionResult } from '@/lib/actions';
import { now } from '@/lib/server';
import { actorOf, inTenant, requireSession } from '@/lib/session';

export async function approveScriptAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    await inTenant(s, (tx) =>
      approveScript(tx, actorOf(s), s.role, field(form, 'id'), now(), {
        dltTemplateId: optionalField(form, 'dlt_template_id'),
      }),
    );
    revalidatePath('/app/scripts');
    return 'Approved — new calls use this version.';
  });
}

/** ADR-0010 §8: this draft against the live version, arm chosen per call. */
export async function startAbTestAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    await inTenant(s, (tx) =>
      startAbTest(tx, actorOf(s), s.role, field(form, 'id'), now(), {
        dltTemplateId: optionalField(form, 'dlt_template_id'),
      }),
    );
    revalidatePath('/app/scripts');
    return 'Test started — calls are split between the two versions.';
  });
}

export async function endAbTestAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    await inTenant(s, (tx) => endAbTest(tx, actorOf(s), s.role, field(form, 'keep'), now()));
    revalidatePath('/app/scripts');
    return 'Test ended — every call now uses the version you kept.';
  });
}
