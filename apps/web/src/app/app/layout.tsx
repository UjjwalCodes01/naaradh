import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { accountBanner, roleAtLeast, type Role } from '@naaradh/pipeline';
import { Banner } from '@/components/ui';
import { requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';
import { signOut } from './actions';

export const metadata: Metadata = { title: 'Dashboard', robots: { index: false } };

const NAV: [string, string, Role][] = [
  ['/app', 'Overview', 'viewer'],
  ['/app/orders', 'Order calls', 'viewer'],
  ['/app/support-calls', 'Support calls', 'viewer'],
  ['/app/tickets', 'Tickets', 'viewer'],
  ['/app/knowledge', 'Knowledge base', 'operator'],
  ['/app/agent', 'Support agent', 'manager'],
  ['/app/scripts', 'Call scripts', 'manager'],
  ['/app/privacy', 'Privacy & opt-outs', 'operator'],
  ['/app/billing', 'Billing', 'viewer'],
  ['/app/settings', 'Settings', 'manager'],
  ['/app/team', 'Team', 'manager'],
  ['/app/developers', 'Developers', 'owner'],
  ['/app/activity', 'Access log', 'manager'],
];

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const s = await requireSession();
  const t = await tenantSettings();
  const banner = accountBanner({
    status: t.status,
    pausedReason: t.pausedReason,
    billingStatus: t.billingStatus,
    billingGraceUntil: t.billingGraceUntil,
    reviewUntil: t.reviewUntil,
  });
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r border-slate-200 bg-white p-4 md:block">
        <Link href="/app" className="block text-lg font-semibold">
          Naaradh
        </Link>
        <p className="mt-1 truncate text-xs text-slate-500" title={s.tenantName}>
          {s.tenantName}
        </p>
        <nav className="mt-6 space-y-1 text-sm">
          {NAV.filter(([, , min]) => roleAtLeast(s.role, min)).map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="block rounded px-2 py-1.5 text-slate-700 hover:bg-slate-100 hover:text-slate-900"
            >
              {label}
            </Link>
          ))}
        </nav>
        <form action={signOut} className="mt-8 border-t border-slate-200 pt-4">
          <p className="truncate text-xs text-slate-500">{s.email}</p>
          <p className="text-xs capitalize text-slate-400">{s.role}</p>
          <button
            type="submit"
            className="mt-2 text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            Sign out
          </button>
        </form>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <Link href="/app" className="font-semibold">
            Naaradh
          </Link>
          <span className="ml-2 text-xs text-slate-500">{s.tenantName}</span>
        </div>
        <main className="mx-auto max-w-6xl px-4 py-6">
          {banner === null ? null : (
            <Banner tone={banner.tone} title={banner.title}>
              {banner.body}
            </Banner>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
