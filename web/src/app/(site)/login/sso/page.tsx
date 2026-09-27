import type { Metadata } from 'next';
import Link from 'next/link';
import { SSO_SLUG } from '@naaradh/pipeline';
import { SitePage } from '@/components/site/ui';

export const metadata: Metadata = { title: 'Single sign-on', robots: { index: false } };

type Search = Promise<{ code?: string }>;

/**
 * The code a person pasted, turned into a plain link to the start route. A link and not a
 * redirect: leaving for the identity provider from a form submission would be blocked by the
 * `form-action 'self'` policy, and a click on a link is not a form submission.
 */
export default async function SsoCode({ searchParams }: { searchParams: Search }) {
  const code = ((await searchParams).code ?? '').trim().toLowerCase();
  const valid = SSO_SLUG.test(code);
  return (
    <SitePage>
      <div className="mx-auto max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold text-ink">Single sign-on</h1>
        {valid ? (
          <>
            <p className="text-sm text-body">
              You will sign in on your organisation&rsquo;s own page, then come straight back.
            </p>
            {/* A plain anchor, not <Link>: this must be a full navigation. A client-side
                fetch would follow the redirect to the provider and be refused by the
                `connect-src 'self'` policy. */}
            <a
              href={`/auth/sso/start/${code}`}
              className="inline-block rounded-lg bg-forest px-4 py-2 text-sm font-medium text-cream"
            >
              Continue to your organisation&rsquo;s sign-in
            </a>
          </>
        ) : (
          <p role="alert" className="text-sm text-body">
            That is not a sign-in code. It is the 16 letters and numbers at the end of the link your
            Naaradh owner shared.{' '}
            <Link href="/login" className="font-medium text-forest underline">
              Back to sign-in
            </Link>
          </p>
        )}
      </div>
    </SitePage>
  );
}
