import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Small, dependency-free UI kit (Tailwind). Server components only; the one interactive piece
 * is <ActionForm>. Tone colours carry meaning consistently: good = done/billable, warning =
 * needs a look, bad = broken or stopped.
 */

export type Tone = 'good' | 'neutral' | 'warning' | 'bad';

const toneClass: Record<Tone, string> = {
  good: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  bad: 'bg-rose-50 text-rose-800 ring-rose-200',
};

export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${toneClass[tone]}`}
    >
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {description === undefined ? null : (
          <p className="mt-1 max-w-3xl text-sm text-slate-600">{description}</p>
        )}
      </div>
      {actions}
    </div>
  );
}

export function Card({
  title,
  children,
  className = '',
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
      {title === undefined ? null : (
        <h2 className="mb-3 text-sm font-semibold text-slate-900">{title}</h2>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {hint === undefined ? null : <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function Table({
  head,
  children,
  empty,
}: {
  head: string[];
  children: ReactNode;
  empty?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            {head.map((h) => (
              <th
                key={h}
                scope="col"
                className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
      {empty === undefined ? null : (
        <p className="hidden p-6 text-center text-sm text-slate-500 only:block">{empty}</p>
      )}
    </div>
  );
}

export function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <td className={`whitespace-nowrap px-3 py-2 align-top text-slate-700 ${className}`}>
      {children}
    </td>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
      {children}
    </p>
  );
}

export function Banner({
  tone,
  title,
  children,
}: {
  tone: 'warning' | 'bad' | 'good';
  title: string;
  children: ReactNode;
}) {
  const cls =
    tone === 'bad'
      ? 'border-rose-200 bg-rose-50 text-rose-900'
      : tone === 'warning'
        ? 'border-amber-200 bg-amber-50 text-amber-900'
        : 'border-emerald-200 bg-emerald-50 text-emerald-900';
  return (
    <div role="status" className={`mb-6 rounded-lg border p-4 text-sm ${cls}`}>
      <p className="font-semibold">{title}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-indigo-700 hover:text-indigo-900 hover:underline">
      {children}
    </Link>
  );
}

export function Label({
  htmlFor,
  children,
  hint,
}: {
  htmlFor: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-800">
      {children}
      {hint === undefined ? null : (
        <span className="mt-0.5 block text-xs font-normal text-slate-500">{hint}</span>
      )}
    </label>
  );
}

export const inputClass =
  'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';

export function Pager({ next, base }: { next: string | null; base: string }) {
  if (next === null) return null;
  const sep = base.includes('?') ? '&' : '?';
  return (
    <div className="mt-4 text-right">
      <TextLink href={`${base}${sep}cursor=${encodeURIComponent(next)}`}>Older →</TextLink>
    </div>
  );
}

export function DefinitionList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-500">{k}</dt>
          <dd className="text-slate-900">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
