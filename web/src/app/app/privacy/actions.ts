'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  addSuppression,
  checkNumber,
  fileErasureRequest,
  liftSuppression,
} from '@naaradh/pipeline';
import { field, optionalField, run, type ActionResult } from '@/lib/actions';
import { env } from '@/lib/env';
import { now } from '@/lib/server';
import { actorOf, inTenant, requireSession } from '@/lib/session';

export async function addSuppressionAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('operator');
    const input = z
      .object({
        purpose: z.enum(['transactional', 'service', 'promotional', 'all']),
        reason: z.enum(['opt_out', 'manual', 'wrong_number', 'invalid']),
      })
      .parse({ purpose: field(form, 'purpose'), reason: field(form, 'reason') });
    const notes = optionalField(form, 'notes');
    const r = await inTenant(s, (tx) =>
      addSuppression(
        tx,
        actorOf(s),
        s.role,
        env().PHONE_HASH_KEY,
        {
          phone: field(form, 'phone'),
          region: 'IN',
          ...input,
          ...(notes === null ? {} : { notes }),
        },
        now(),
      ),
    );
    revalidatePath('/app/privacy');
    return r.created
      ? 'Added. Naaradh will not call this number for that purpose.'
      : 'Already blocked.';
  });
}

export async function liftSuppressionAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    await inTenant(s, (tx) =>
      liftSuppression(tx, actorOf(s), s.role, field(form, 'id'), field(form, 'reason'), now()),
    );
    revalidatePath('/app/privacy');
    return 'Lifted.';
  });
}

export async function checkNumberAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('operator');
    const rows = await inTenant(s, (tx) =>
      checkNumber(tx, s.tenantId, env().PHONE_HASH_KEY, field(form, 'phone'), 'IN'),
    );
    if (rows.length === 0) return 'Not blocked.';
    return rows
      .map(
        (r) =>
          `${r.scope === 'naaradh' ? 'Blocked for every business' : 'Blocked by you'}: ${r.reason.replaceAll('_', ' ')} (${r.purpose})`,
      )
      .join(' · ');
  });
}

export async function fileErasureAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    if (form.get('verified') !== 'on')
      return {
        ok: false,
        message: 'Confirm you have verified the request comes from the customer.',
      };
    const ref = optionalField(form, 'external_ref');
    const r = await inTenant(s, (tx) =>
      fileErasureRequest(
        tx,
        actorOf(s),
        s.role,
        env().PHONE_HASH_KEY,
        {
          phone: field(form, 'phone'),
          region: 'IN',
          ...(ref === null ? {} : { externalRef: ref }),
        },
        now(),
      ),
    );
    revalidatePath('/app/privacy');
    return `Erasure requested; it completes by ${r.dueAt.toISOString().slice(0, 10)} at the latest.`;
  });
}
