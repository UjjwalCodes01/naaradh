'use server';

import { revalidatePath } from 'next/cache';
import { SsoSettingsInput, saveSsoSettings, setSsoEnforced, setSsoStatus } from '@naaradh/pipeline';
import { NaaradhError } from '@naaradh/shared';
import { field, run, type ActionResult } from '@/lib/actions';
import { actorOf, inTenant, requireSession } from '@/lib/session';
import { ssoKey } from '@/lib/sso';

/** Owners only: single sign-on decides who can enter the whole account (P7-ENT-1). */
export async function saveSso(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('owner');
    const key = ssoKey();
    if (key === null)
      throw new NaaradhError('VALIDATION_FAILED', 'single sign-on is not available yet');
    const input = SsoSettingsInput.parse({
      issuer: field(form, 'issuer'),
      client_id: field(form, 'client_id'),
      client_secret: field(form, 'client_secret'),
      email_domains: field(form, 'email_domains')
        .split(/[\s,]+/)
        .filter((d) => d !== ''),
    });
    await inTenant(s, (tx) => saveSsoSettings(tx, actorOf(s), key, input));
    revalidatePath('/app/settings/sso');
    return 'Saved. Sign in once through the link below to prove it works.';
  });
}

export async function enforceSso(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('owner');
    const on = field(form, 'enforced') === 'true';
    await inTenant(s, (tx) => setSsoEnforced(tx, actorOf(s), on));
    revalidatePath('/app/settings/sso');
    return on
      ? 'Single sign-on is now required. Owners keep the email link as a way back in.'
      : 'Email links work again for everyone.';
  });
}

export async function switchSso(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('owner');
    const status = field(form, 'status') === 'testing' ? 'testing' : 'disabled';
    await inTenant(s, (tx) => setSsoStatus(tx, actorOf(s), status));
    revalidatePath('/app/settings/sso');
    return status === 'disabled'
      ? 'Single sign-on is off. Everyone signs in with the email link.'
      : 'Single sign-on is back on, in testing until someone signs in with it.';
  });
}
