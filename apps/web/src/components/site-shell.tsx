import Link from 'next/link';
import type { ReactNode } from 'react';

const NAV = [
  ['/pricing', 'Pricing'],
  ['/security', 'Security'],
  ['/do-not-call', 'Do not call'],
  ['/app', 'Sign in'],
] as const;

const FOOTER = [
  ['/privacy', 'Privacy'],
  ['/terms', 'Terms'],
  ['/dpa', 'DPA'],
  ['/aup', 'Acceptable use'],
  ['/subprocessors', 'Sub-processors'],
  ['/cookies', 'Cookies'],
  ['/refunds', 'Refunds'],
  ['/grievance', 'Grievance officer'],
  ['/contact', 'Contact'],
  ['/do-not-call', 'Do not call'],
] as const;

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight text-slate-900">
            Naaradh
          </Link>
          <nav className="flex gap-5 text-sm text-slate-600">
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} className="hover:text-slate-900">
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10">{children}</main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap gap-x-5 gap-y-2 px-4 py-6 text-xs text-slate-500">
          {FOOTER.map(([href, label]) => (
            <Link key={href} href={href} className="hover:text-slate-800">
              {label}
            </Link>
          ))}
          <span className="ml-auto">© Naaradh</span>
        </div>
      </footer>
    </div>
  );
}
