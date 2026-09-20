import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import {
  MERCHANT_ATTESTATION,
  SettingsInput,
  getSettings,
  listScripts,
  listUseCases,
  recordAttestation,
  setUseCaseEnabled,
  updateSettings,
  usageSummary,
} from '@naaradh/pipeline';
import { errorMessage, formValue, shopContext } from '../lib/context.server';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await shopContext(request);
  return ctx.inTenant(async (tx) => ({
    settings: await getSettings(tx, ctx.tenantId),
    useCases: await listUseCases(tx, ctx.tenantId),
    attestationText: [...MERCHANT_ATTESTATION],
  }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await shopContext(request);
  const form = await request.formData();
  const intent = formValue(form, 'intent');
  try {
    return await ctx.inTenant(async (tx) => {
      const t = await getSettings(tx, ctx.tenantId);
      if (intent === 'details') {
        const opt = (n: string) =>
          formValue(form, n).trim() === '' ? null : formValue(form, n).trim();
        const cap = opt('spend_cap_monthly');
        await updateSettings(
          tx,
          ctx.actor,
          ctx.role,
          SettingsInput.parse({
            ...t,
            legal_name: opt('legal_name'),
            gstin: opt('gstin'),
            pan: opt('pan'),
            dlt_pe_id: opt('dlt_pe_id'),
            spend_cap_monthly_paise: cap === null ? null : Math.round(Number(cap) * 100),
            auto_cancel_enabled: form.get('auto_cancel_enabled') === 'on',
          }),
        );
        if (form.get('attest') === 'on' && t.attestation === null)
          await recordAttestation(
            tx,
            ctx.actor,
            formValue(form, 'attested_by') || 'store owner',
            new Date(),
          );
        return { ok: true, message: 'Saved.' };
      }
      if (intent === 'go_live' || intent === 'pause') {
        const cod = (await listUseCases(tx, ctx.tenantId)).find((u) => u.kind === 'cod_confirm');
        if (cod === undefined)
          return { ok: false, message: 'COD confirmation is not set up for this store yet.' };
        if (intent === 'go_live') {
          const approved = (await listScripts(tx, ctx.tenantId)).some(
            (s) => s.useCase === 'cod_confirm' && s.status === 'approved',
          );
          const usage = await usageSummary(tx, ctx.tenantId, new Date());
          const missing = [
            ...(t.attestation === null ? ['accept the compliance declaration'] : []),
            ...(approved ? [] : ['approve a COD confirmation script']),
            ...(usage.subscription?.status === 'active' ? [] : ['choose a plan']),
          ];
          if (missing.length > 0)
            return { ok: false, message: `Before going live: ${missing.join(', ')}.` };
        }
        await setUseCaseEnabled(tx, ctx.actor, ctx.role, cod.id, intent === 'go_live');
        return {
          ok: true,
          message:
            intent === 'go_live'
              ? 'Live. New COD orders are called within minutes, 09:00–21:00 IST.'
              : 'Paused. No new COD calls.',
        };
      }
      return { ok: false, message: 'Unknown action.' };
    });
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
};

export default function Setup() {
  const { settings: t, useCases, attestationText } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== 'idle';
  const cod = useCases.find((u) => u.kind === 'cod_confirm');
  return (
    <s-page heading="Setup">
      {result === undefined ? null : (
        <s-banner tone={result.ok ? 'success' : 'critical'}>{result.message}</s-banner>
      )}
      <Form method="post">
        <input type="hidden" name="intent" value="details" />
        <s-section heading="Business details">
          <s-text-field
            name="legal_name"
            label="Legal business name"
            value={t.legal_name ?? ''}
          ></s-text-field>
          <s-text-field
            name="gstin"
            label="GSTIN"
            value={t.gstin ?? ''}
            details="Optional. 15 characters."
          ></s-text-field>
          <s-text-field name="pan" label="PAN" value={t.pan ?? ''}></s-text-field>
          <s-text-field
            name="dlt_pe_id"
            label="DLT Principal Entity ID"
            value={t.dlt_pe_id ?? ''}
            details="Needed for promotional calls. COD confirmation calls are transactional and run without it."
          ></s-text-field>
        </s-section>
        <s-section heading="Spending and store updates">
          <s-number-field
            name="spend_cap_monthly"
            label="Monthly spending cap (₹)"
            value={
              t.spend_cap_monthly_paise === null ? '' : String(t.spend_cap_monthly_paise / 100)
            }
            details="Calls pause when it is reached."
          ></s-number-field>
          <s-checkbox
            name="auto_cancel_enabled"
            label="Cancel the order in Shopify when the customer cancels on the call"
            details="Only when the agent is at least 90% sure; otherwise the order is tagged for you. Addresses are never changed."
            checked={t.auto_cancel_enabled}
          ></s-checkbox>
        </s-section>
        <s-section heading="Compliance declaration">
          {t.attestation === null ? (
            <>
              <s-unordered-list>
                {attestationText.map((line) => (
                  <s-list-item key={line}>{line}</s-list-item>
                ))}
              </s-unordered-list>
              <s-text-field name="attested_by" label="Your name"></s-text-field>
              <s-checkbox
                name="attest"
                label="I agree to the above on behalf of the business"
              ></s-checkbox>
            </>
          ) : (
            <s-paragraph>
              Accepted on {t.attestation.acceptedAt.slice(0, 10)} (version {t.attestation.version}).
            </s-paragraph>
          )}
        </s-section>
        <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
          Save
        </s-button>
      </Form>
      <s-section heading="COD confirmation">
        <s-paragraph>
          {cod?.enabled === true
            ? 'Live: new COD orders are called within minutes, inside 09:00–21:00 IST. Orders placed too late to call in time are not called and are marked in the dashboard.'
            : 'Off. Go live once your script is approved and a plan is active.'}
        </s-paragraph>
        <Form method="post">
          <input type="hidden" name="intent" value={cod?.enabled === true ? 'pause' : 'go_live'} />
          <s-button
            type="submit"
            {...(cod?.enabled === true ? { tone: 'critical' } : { variant: 'primary' })}
          >
            {cod?.enabled === true ? 'Pause COD calls' : 'Go live'}
          </s-button>
        </Form>
      </s-section>
    </s-page>
  );
}
