import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { Form, useActionData, useLoaderData } from 'react-router';
import {
  ProfileInput,
  createProfile,
  getSettings,
  listProfiles,
  setProfileStatus,
  updateProfile,
} from '@naaradh/pipeline';
import {
  DEFAULT_CLOSED_MESSAGES,
  DEFAULT_INBOUND_GREETINGS,
  TOOL_NAMES,
} from '@naaradh/call-scripts';
import { errorMessage, formValue, shopContext } from '../lib/context.server';
import { env } from '../lib/env.server';

/**
 * Quick setup of the support line (ADR-0006) inside Shopify admin: language, hours, the number
 * calls fall back to. The full editor (pinned facts, tools, transfer numbers, knowledge base)
 * is in the dashboard. Agent cancellations stay OFF here — the merchant turns them on there.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await shopContext(request);
  return ctx.inTenant(async (tx) => ({
    profiles: await listProfiles(tx, ctx.tenantId),
    zone: (await getSettings(tx, ctx.tenantId)).timezone,
    dashboardUrl: env().DASHBOARD_URL,
  }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await shopContext(request);
  const form = await request.formData();
  const e = env();
  const staff = {
    hashKey: e.PHONE_HASH_KEY,
    publicKeyPem: e.STAFF_ENC_PUBLIC_KEY,
    kid: e.STAFF_ENC_KID,
  };
  try {
    return await ctx.inTenant(async (tx) => {
      const existing = (await listProfiles(tx, ctx.tenantId))[0];
      if (formValue(form, 'intent') === 'status' && existing !== undefined) {
        const status = existing.status === 'active' ? 'disabled' : 'active';
        await setProfileStatus(tx, ctx.actor, existing.id, status);
        return {
          ok: true,
          message:
            status === 'active'
              ? 'Support line agent is on.'
              : 'Off — calls go to your fallback number.',
        };
      }
      const locale = formValue(form, 'locale') === 'en-IN' ? 'en-IN' : 'hi-IN';
      const fallback = formValue(form, 'fallback').trim();
      const input = ProfileInput.parse({
        name: existing?.name ?? 'Support line',
        locale,
        greeting:
          existing?.locale === locale ? existing.greeting : DEFAULT_INBOUND_GREETINGS[locale],
        persona: existing?.persona ?? null,
        pinned_facts: existing?.pinned_facts ?? [],
        tools_enabled:
          existing?.tools_enabled ?? TOOL_NAMES.filter((t) => t !== 'request_cancellation'),
        closed_message:
          existing?.locale === locale ? existing.closed_message : DEFAULT_CLOSED_MESSAGES[locale],
        business_hours: {
          zone: formValue(form, 'zone') || 'Asia/Kolkata',
          days: form.getAll('days').map(Number),
          open: formValue(form, 'open'),
          close: formValue(form, 'close'),
        },
        fallback_forward: fallback === '' ? null : { phone: fallback, phone_region: 'IN' },
        transfer_target_id: existing?.transfer_target_id ?? null,
        max_duration_sec: existing?.max_duration_sec ?? 600,
        max_concurrent: existing?.max_concurrent ?? 2,
        max_calls_per_caller_hour: existing?.max_calls_per_caller_hour ?? 6,
        monthly_minute_cap: existing?.monthly_minute_cap ?? null,
        agent_cancel_enabled: existing?.agent_cancel_enabled ?? false,
        voice_id: existing?.voice_id ?? null,
      });
      if (existing === undefined) await createProfile(tx, ctx.actor, staff, input);
      else await updateProfile(tx, ctx.actor, staff, existing.id, input, { keepFallback: true });
      return { ok: true, message: 'Saved.' };
    });
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
};

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function Support() {
  const { profiles, zone, dashboardUrl } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const p = profiles[0];
  const hours = (p?.business_hours ?? {
    zone,
    days: [1, 2, 3, 4, 5, 6],
    open: '10:00',
    close: '19:00',
  }) as {
    zone: string;
    days: number[];
    open: string;
    close: string;
  };
  return (
    <s-page heading="Support line">
      {result === undefined ? null : (
        <s-banner tone={result.ok ? 'success' : 'critical'}>{result.message}</s-banner>
      )}
      <s-paragraph>
        The agent answers your support number around the clock: order status for verified callers,
        your policies, tickets for anything it cannot do, and a transfer to your team inside your
        hours. Your support number is connected by the Naaradh team during onboarding.
      </s-paragraph>
      <Form method="post">
        <input type="hidden" name="intent" value="save" />
        <s-section heading="Basics">
          <s-select name="locale" label="Language" value={p?.locale ?? 'hi-IN'}>
            <s-option value="hi-IN">Hindi / Hinglish</s-option>
            <s-option value="en-IN">English</s-option>
          </s-select>
          <s-text-field
            name="fallback"
            label="Fallback number"
            details={
              p?.fallback_forward
                ? `Current: ${p.fallback_forward}. Leave blank to keep it.`
                : 'Where calls go when the agent cannot take them.'
            }
          ></s-text-field>
          <input type="hidden" name="zone" value={hours.zone} />
          <s-text-field name="open" label="Opens" value={hours.open}></s-text-field>
          <s-text-field name="close" label="Closes" value={hours.close}></s-text-field>
          <s-stack direction="inline" gap="base">
            {DAYS.map((d, i) => (
              <label key={d}>
                <input
                  type="checkbox"
                  name="days"
                  value={i + 1}
                  defaultChecked={hours.days.includes(i + 1)}
                />{' '}
                {d}
              </label>
            ))}
          </s-stack>
        </s-section>
        <s-button type="submit" variant="primary">
          Save
        </s-button>
      </Form>
      {p === undefined ? null : (
        <s-section heading={`Agent: ${p.status}`}>
          <Form method="post">
            <input type="hidden" name="intent" value="status" />
            <s-button
              type="submit"
              {...(p.status === 'active' ? { tone: 'critical' } : { variant: 'primary' })}
            >
              {p.status === 'active' ? 'Turn off' : 'Turn on'}
            </s-button>
          </Form>
        </s-section>
      )}
      <s-section heading="More">
        <s-button href={`${dashboardUrl}/app/agent`} target="_blank">
          Knowledge base, transfer numbers and tools
        </s-button>
      </s-section>
    </s-page>
  );
}
