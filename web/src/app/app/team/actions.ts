'use server';

import { revalidatePath } from 'next/cache';
import { inviteEmail } from '@naaradh/notify';
import {
  InviteInput,
  ROLES,
  changeRole,
  disableUser,
  inviteUser,
  revokeSessions,
} from '@naaradh/pipeline';
import { z } from 'zod';
import { field, optionalField, run, type ActionResult } from '@/lib/actions';
import { env } from '@/lib/env';
import { log, mailer, now } from '@/lib/server';
import { actorOf, inTenant, requireSession } from '@/lib/session';

export async function invite(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    const input = InviteInput.parse({
      email: field(form, 'email'),
      name: optionalField(form, 'name'),
      role: field(form, 'role'),
    });
    await inTenant(s, (tx) => inviteUser(tx, actorOf(s), s.role, input));
    try {
      await mailer().send(
        inviteEmail({
          to: input.email,
          accountName: s.tenantName,
          invitedBy: s.name ?? s.email,
          role: input.role,
          url: `${env().APP_URL}/login`,
        }),
      );
    } catch (error) {
      log().error({ err: error, tenant_id: s.tenantId }, 'invite email failed');
      return {
        ok: true,
        message:
          'Added, but the invitation email could not be sent. They can sign in at /login with this address.',
      };
    }
    revalidatePath('/app/team');
    return `Invited ${input.email}.`;
  });
}

export async function setRole(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    const role = z.enum(ROLES).parse(field(form, 'role'));
    await inTenant(s, (tx) => changeRole(tx, actorOf(s), s.role, field(form, 'user_id'), role));
    revalidatePath('/app/team');
    return 'Role updated.';
  });
}

export async function removeUser(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    await inTenant(s, (tx) => disableUser(tx, actorOf(s), s.role, field(form, 'user_id'), now()));
    revalidatePath('/app/team');
    return 'Removed and signed out everywhere.';
  });
}

export async function signOutEverywhere(_prev: ActionResult): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession();
    const n = await inTenant(s, (tx) =>
      revokeSessions(tx, actorOf(s), { userId: s.userId }, now()),
    );
    return `Signed out of ${String(n)} session${n === 1 ? '' : 's'}, including this one.`;
  });
}
