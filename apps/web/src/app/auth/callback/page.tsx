import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteShell } from '@/components/site-shell';
import { completeSignIn } from './actions';

export const metadata: Metadata = { title: 'Sign in', robots: { index: false } };

type Search = Promise<{ token?: string; expired?: string }>;

export default async function Callback({ searchParams }: { searchParams: Search }) {
  const { token, expired } = await searchParams;
  const valid = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
  return (
    <SiteShell>
      <div className="mx-auto max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6">
        {expired !== undefined || !valid ? (
          <>
            <h1 className="text-lg font-semibold">This link has expired or was already used</h1>
            <p className="text-sm text-slate-600">Sign-in links work once and for 15 minutes.</p>
            <Link href="/login" className="text-sm font-medium text-indigo-700 underline">
              Get a new link
            </Link>
          </>
        ) : (
          <form action={completeSignIn} className="space-y-4">
            <h1 className="text-lg font-semibold">Continue to Naaradh</h1>
            <input type="hidden" name="token" value={token} />
            <button
              type="submit"
              className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Sign in
            </button>
          </form>
        )}
      </div>
    </SiteShell>
  );
}
