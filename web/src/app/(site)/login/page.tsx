import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { inputClass } from '@/components/ui';
import { currentSession } from '@/lib/session';
import { SSO_MESSAGES } from '@/lib/sso';
import { requestLoginLink } from './actions';
import { SitePage } from '@/components/site/ui';

export const metadata: Metadata = { title: 'Sign in', robots: { index: false } };

type Search = Promise<{ sso?: string }>;

export default async function Login({ searchParams }: { searchParams: Search }) {
  if ((await currentSession()) !== null) redirect('/app');
  const refusal = (await searchParams).sso;
  const ssoMessage =
    refusal !== undefined && refusal in SSO_MESSAGES
      ? SSO_MESSAGES[refusal as keyof typeof SSO_MESSAGES]
      : null;
  return (
    <SitePage>
      <div className="mx-auto max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Sign in</h1>
          <p className="mt-2 text-sm text-body">
            We’ll email you a link. No passwords. Shopify merchants can also open Naaradh from
            Shopify admin.
          </p>
        </div>
        {ssoMessage === null ? null : (
          <p
            role="alert"
            className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-ink"
          >
            {ssoMessage}
          </p>
        )}
        <div className="rounded-2xl border border-line bg-white p-5">
          <ActionForm action={requestLoginLink} submit="Email me a sign-in link">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-ink">
                Work email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                className={inputClass}
              />
            </div>
          </ActionForm>
        </div>
        <div className="rounded-2xl border border-line bg-white p-5">
          <h2 className="text-sm font-semibold text-ink">Single sign-on</h2>
          <p className="mt-1 text-sm text-body">
            If your organisation signs in through Okta, Microsoft or Google, use the sign-in link
            your Naaradh owner shared, or paste its code here.
          </p>
          <form method="get" action="/login/sso" className="mt-3 flex gap-2">
            <label htmlFor="sso-code" className="sr-only">
              Sign-in code
            </label>
            <input
              id="sso-code"
              name="code"
              required
              pattern="[a-z0-9]{16}"
              title="16 letters and numbers, from your sign-in link"
              autoComplete="off"
              className={inputClass}
            />
            <button
              type="submit"
              className="shrink-0 rounded-lg border border-line px-3 text-sm font-medium text-ink hover:bg-cream"
            >
              Continue
            </button>
          </form>
        </div>
      </div>
    </SitePage>
  );
}
