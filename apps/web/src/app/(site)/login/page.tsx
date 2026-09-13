import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { inputClass } from '@/components/ui';
import { currentSession } from '@/lib/session';
import { requestLoginLink } from './actions';

export const metadata: Metadata = { title: 'Sign in', robots: { index: false } };

export default async function Login() {
  if ((await currentSession()) !== null) redirect('/app');
  return (
    <div className="mx-auto max-w-sm space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Sign in</h1>
        <p className="mt-2 text-sm text-slate-600">
          We’ll email you a link. No passwords. Shopify merchants can also open Naaradh from Shopify
          admin.
        </p>
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <ActionForm action={requestLoginLink} submit="Email me a sign-in link">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate-800">
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
    </div>
  );
}
