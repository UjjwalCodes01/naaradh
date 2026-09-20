'use server';

import { revalidatePath } from 'next/cache';
import {
  ATTESTATION_STATEMENT,
  AttestationInput,
  ProfileInput,
  TransferTargetInput,
  createProfile,
  createTransferTarget,
  deactivateTransferTarget,
  setProfileStatus,
  updateProfile,
  verifyTransferTarget,
  type StaffKeys,
} from '@naaradh/pipeline';
import { checkbox, field, optionalField, run, type ActionResult } from '@/lib/actions';
import { env } from '@/lib/env';
import { now } from '@/lib/server';
import { actorOf, inTenant, requireSession } from '@/lib/session';

function staffKeys(): StaffKeys {
  const e = env();
  return { hashKey: e.PHONE_HASH_KEY, publicKeyPem: e.STAFF_ENC_PUBLIC_KEY, kid: e.STAFF_ENC_KID };
}

const lines = (v: string) =>
  v
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

function parseProfile(form: FormData) {
  const fallback = optionalField(form, 'fallback_phone');
  const cap = optionalField(form, 'monthly_minute_cap');
  return ProfileInput.parse({
    name: field(form, 'name'),
    locale: field(form, 'locale'),
    greeting: field(form, 'greeting'),
    persona: optionalField(form, 'persona'),
    pinned_facts: lines(field(form, 'pinned_facts')),
    tools_enabled: form.getAll('tools').map(String),
    closed_message: field(form, 'closed_message'),
    business_hours: {
      zone: field(form, 'zone') || 'Asia/Kolkata',
      days: form.getAll('days').map(Number),
      open: field(form, 'open'),
      close: field(form, 'close'),
    },
    fallback_forward: fallback === null ? null : { phone: fallback, phone_region: 'IN' },
    transfer_target_id: optionalField(form, 'transfer_target_id'),
    max_duration_sec: Number(field(form, 'max_duration_sec') || 600),
    max_concurrent: Number(field(form, 'max_concurrent') || 2),
    max_calls_per_caller_hour: Number(field(form, 'max_calls_per_caller_hour') || 6),
    monthly_minute_cap: cap === null ? null : Number(cap),
    agent_cancel_enabled: checkbox(form, 'agent_cancel_enabled'),
    voice_id: optionalField(form, 'voice_id'),
  });
}

export async function saveProfile(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    const input = parseProfile(form);
    const id = optionalField(form, 'id');
    await inTenant(s, async (tx) => {
      if (id === null) await createProfile(tx, actorOf(s), staffKeys(), input);
      // A blank fallback number keeps the stored one — the dashboard cannot show it back.
      else await updateProfile(tx, actorOf(s), staffKeys(), id, input, { keepFallback: true });
    });
    revalidatePath('/app/agent');
    return id === null
      ? 'Profile created as a draft. Activate it when it reads right.'
      : 'Saved — a new version is live for new calls.';
  });
}

export async function setProfileStatusAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    const status = field(form, 'status') === 'active' ? 'active' : 'disabled';
    await inTenant(s, (tx) => setProfileStatus(tx, actorOf(s), field(form, 'id'), status));
    revalidatePath('/app/agent');
    return status === 'active' ? 'Active.' : 'Disabled — calls go to your fallback number.';
  });
}

export async function addTransferTarget(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    const input = TransferTargetInput.parse({
      label: field(form, 'label'),
      phone: field(form, 'phone'),
      phone_region: 'IN',
      hours: null,
    });
    const r = await inTenant(s, (tx) => createTransferTarget(tx, actorOf(s), staffKeys(), input));
    revalidatePath('/app/agent');
    return `Added ${r.phone}. Verify it before calls can be transferred there.`;
  });
}

export async function verifyTransferTargetAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    const input = AttestationInput.parse({
      attested_by: s.name ?? s.email,
      role: s.role === 'owner' ? 'owner' : 'manager',
      statement: form.get('attest') === 'on' ? ATTESTATION_STATEMENT : '',
    });
    await inTenant(s, (tx) =>
      verifyTransferTarget(tx, actorOf(s), field(form, 'id'), input, now()),
    );
    revalidatePath('/app/agent');
    return 'Verified.';
  });
}

export async function deactivateTransferTargetAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    await inTenant(s, (tx) => deactivateTransferTarget(tx, actorOf(s), field(form, 'id')));
    revalidatePath('/app/agent');
    return 'Deactivated.';
  });
}
