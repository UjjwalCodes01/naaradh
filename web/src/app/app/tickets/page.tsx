import Link from 'next/link';
import { listTickets, roleAtLeast, type TicketStatus } from '@naaradh/pipeline';
import { ActionForm } from '@/components/action-form';
import { Badge, Empty, PageHeader, TextLink, inputClass } from '@/components/ui';
import { formatDateTime, humanise } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';
import { resolveTicketAction, startTicketAction } from './actions';

const TABS: [TicketStatus, string][] = [
  ['open', 'Open'],
  ['in_progress', 'In progress'],
  ['resolved', 'Resolved'],
];

type Search = Promise<{ status?: string }>;

export default async function Tickets({ searchParams }: { searchParams: Search }) {
  const s = await requireSession();
  const tz = (await tenantSettings()).timezone;
  const sp = await searchParams;
  const status = TABS.find(([t]) => t === sp.status)?.[0] ?? 'open';
  const rows = await inTenant(s, (tx) => listTickets(tx, s.tenantId, { status }));
  const canWork = roleAtLeast(s.role, 'operator');
  return (
    <div>
      <PageHeader
        title="Tickets"
        description="What callers needed that only your team can do: address changes, refunds, callbacks, questions your knowledge base could not answer."
      />
      <div className="mb-4 flex gap-2">
        {TABS.map(([t, label]) => (
          <Link
            key={t}
            href={`/app/tickets?status=${t}`}
            className={`rounded-full px-3 py-1 text-sm ${t === status ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200'}`}
          >
            {label}
          </Link>
        ))}
      </div>
      {rows.length === 0 ? (
        <Empty>Nothing here.</Empty>
      ) : (
        <ul className="space-y-3">
          {rows.map((t) => (
            <li key={t.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={t.priority >= 70 ? 'warning' : 'neutral'}>
                  {humanise(t.category)}
                </Badge>
                {t.callback_requested ? (
                  <Badge tone="warning">
                    Callback{t.preferred_time === null ? '' : `: ${t.preferred_time}`}
                  </Badge>
                ) : null}
                {t.order_name === null ? null : (
                  <span className="text-slate-600">Order {t.order_name}</span>
                )}
                <span className="ml-auto text-xs text-slate-500">
                  {formatDateTime(t.created_at, tz)}
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-800">{t.summary}</p>
              {t.attempt_id === null ? null : (
                <p className="mt-1 text-xs">
                  <TextLink href={`/app/support-calls/${t.attempt_id}`}>From this call</TextLink>
                </p>
              )}
              {canWork && t.status !== 'resolved' ? (
                <div className="mt-3 flex flex-wrap gap-6 border-t border-slate-100 pt-3">
                  {t.status === 'open' ? (
                    <ActionForm action={startTicketAction} submit="Start">
                      <input type="hidden" name="id" value={t.id} />
                    </ActionForm>
                  ) : null}
                  <ActionForm
                    action={resolveTicketAction}
                    submit="Resolve"
                    className="min-w-72 flex-1"
                  >
                    <input type="hidden" name="id" value={t.id} />
                    <input
                      name="resolution"
                      required
                      minLength={2}
                      maxLength={1000}
                      placeholder="What was done"
                      className={inputClass}
                    />
                  </ActionForm>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
