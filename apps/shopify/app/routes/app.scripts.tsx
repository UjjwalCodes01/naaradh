import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { Form, useActionData, useLoaderData } from 'react-router';
import { approveScript, listScripts } from '@naaradh/pipeline';
import { errorMessage, formValue, shopContext } from '../lib/context.server';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await shopContext(request);
  return { scripts: await ctx.inTenant((tx) => listScripts(tx, ctx.tenantId)) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await shopContext(request);
  const form = await request.formData();
  try {
    await ctx.inTenant((tx) =>
      approveScript(tx, ctx.actor, ctx.role, formValue(form, 'id'), new Date()),
    );
    return { ok: true, message: 'Approved. New calls use this version.' };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
};

export default function Scripts() {
  const { scripts } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <s-page heading="Call scripts">
      {result === undefined ? null : (
        <s-banner tone={result.ok ? 'success' : 'critical'}>{result.message}</s-banner>
      )}
      <s-paragraph>
        Every call starts by saying it is an automated assistant and that the call is recorded. Read
        each script as your customer will hear it; only an approved version is used.
      </s-paragraph>
      {scripts.map((s) => (
        <s-section
          key={s.id}
          heading={`${s.useCase.replaceAll('_', ' ')} · ${s.locale} · v${String(s.version)} · ${s.status}`}
        >
          <s-paragraph>
            <strong>Opening:</strong> {s.opening}
          </s-paragraph>
          <s-paragraph>
            <strong>Purpose:</strong> {s.purposeLine}
          </s-paragraph>
          <s-paragraph>
            <strong>Closing:</strong> {s.closing}
          </s-paragraph>
          {s.problems === null ? null : (
            <s-banner tone="critical">Cannot be approved: {s.problems}</s-banner>
          )}
          {s.status === 'draft' && s.problems === null ? (
            <Form method="post">
              <input type="hidden" name="id" value={s.id} />
              <s-button type="submit" variant="primary">
                Approve
              </s-button>
            </Form>
          ) : null}
        </s-section>
      ))}
    </s-page>
  );
}
