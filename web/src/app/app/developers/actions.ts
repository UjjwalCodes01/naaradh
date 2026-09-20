'use server';

import { revalidatePath } from 'next/cache';
import { ApiKeyInput, createApiKey, revokeApiKey } from '@naaradh/pipeline';
import { field, run, type ActionResult } from '@/lib/actions';
import { now } from '@/lib/server';
import { actorOf, inTenant, requireSession } from '@/lib/session';

export async function createKey(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('owner');
    const kind = field(form, 'kind') === 'public' ? 'public' : 'secret';
    const input = ApiKeyInput.parse({
      name: field(form, 'name'),
      kind,
      env: field(form, 'env') === 'test' ? 'test' : 'live',
      scopes: kind === 'public' ? ['intents:create'] : form.getAll('scopes').map(String),
      allowed_domains: field(form, 'domains')
        .split(/[\s,]+/)
        .filter((d) => d.length > 0),
      daily_cap: field(form, 'daily_cap') === '' ? null : Number(field(form, 'daily_cap')),
    });
    const k = await inTenant(s, (tx) => createApiKey(tx, actorOf(s), s.role, input));
    revalidatePath('/app/developers');
    return { ok: true, message: `Created ${k.prefix}…`, secret: k.key };
  });
}

export async function revokeKey(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('owner');
    await inTenant(s, (tx) =>
      revokeApiKey(tx, actorOf(s), s.role, field(form, 'id'), field(form, 'reason'), now()),
    );
    revalidatePath('/app/developers');
    return 'Revoked — requests with this key now fail.';
  });
}
