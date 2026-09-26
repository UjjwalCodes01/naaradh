'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  ApiKeyInput,
  createApiKey,
  disableProvider,
  enableProvider,
  revokeApiKey,
} from '@naaradh/pipeline';
import { CRM_PROVIDERS } from '@naaradh/crm';
import { OCC_PROVIDERS } from '@naaradh/occ';
import { field, run, type ActionResult } from '@/lib/actions';
import { now } from '@/lib/server';
import { actorOf, inTenant, requireSession } from '@/lib/session';

/** Only the providers we support; anything else is a rejected form, not a 500. */
const ProviderInput = z.enum([...OCC_PROVIDERS, ...CRM_PROVIDERS]);

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

/**
 * Connect a one-click checkout (E-14) or a CRM (P5-CRM-1/2). Enabling only says "what this
 * provider sends is ours"; the URL and secret are derived from PROVIDER_WEBHOOK_KEY and shown on
 * the page, never stored.
 */
export async function connectProvider(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('owner');
    const provider = ProviderInput.parse(field(form, 'provider'));
    // "default" writes nothing, so the provider's own scheme applies. Only an explicit choice is
    // stored, and the server still refuses to go below the provider's default
    // (effectiveSignaturePolicy) — a form cannot turn signature checking off.
    const chosen = field(form, 'signature');
    const policy =
      chosen === 'required' ? 'required' : chosen === 'optional' ? 'optional' : undefined;
    await inTenant(s, (tx) =>
      enableProvider(tx, {
        tenantId: s.tenantId,
        provider,
        accountRef: field(form, 'account_ref'),
        ...(policy === undefined ? {} : { signaturePolicy: policy }),
        actor: actorOf(s).id,
      }),
    );
    revalidatePath('/app/developers');
    return `${provider} is on — paste the URL and secret below into their dashboard.`;
  });
}

export async function disconnectProvider(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('owner');
    const provider = ProviderInput.parse(field(form, 'provider'));
    await inTenant(s, (tx) =>
      disableProvider(tx, { tenantId: s.tenantId, provider, actor: actorOf(s).id }),
    );
    revalidatePath('/app/developers');
    return `${provider} is off — what it sends is recorded but no longer acted on.`;
  });
}
