import Link from 'next/link';
import { listOutbound, type OutboundFilter } from '@naaradh/pipeline';
import { Badge, Empty, PageHeader, Pager, Table, Td, TextLink, inputClass } from '@/components/ui';
import { formatDateTime, formatMoney, humanise } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';

const FILTERS: [OutboundFilter, string][] = [
  ['all', 'All'],
  ['active', 'In progress'],
  ['needs_action', 'Needs action'],
  ['gated', 'Not called'],
  ['completed', 'Finished'],
];

type Search = Promise<{ filter?: string; cursor?: string; q?: string }>;

export default async function Orders({ searchParams }: { searchParams: Search }) {
  const s = await requireSession();
  const tz = (await tenantSettings()).timezone;
  const sp = await searchParams;
  const filter = FILTERS.find(([f]) => f === sp.filter)?.[0] ?? 'all';
  const q = (sp.q ?? '').slice(0, 100);
  const page = await inTenant(s, (tx) =>
    listOutbound(tx, s.tenantId, {
      filter,
      orderRef: q,
      ...(sp.cursor === undefined ? {} : { cursor: sp.cursor }),
    }),
  );
  const base = `/app/orders?filter=${filter}${q === '' ? '' : `&q=${encodeURIComponent(q)}`}`;
  return (
    <div>
      <PageHeader
        title="Order calls"
        description="One row per order Naaradh was asked to call. “Not called” means a compliance check stopped the call — open the order to see which and what to do."
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map(([f, label]) => (
          <Link
            key={f}
            href={`/app/orders?filter=${f}`}
            className={`rounded-full px-3 py-1 text-sm ${f === filter ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200'}`}
          >
            {label}
          </Link>
        ))}
        <form className="ml-auto flex gap-2" action="/app/orders">
          <input type="hidden" name="filter" value={filter} />
          <input
            name="q"
            defaultValue={q}
            placeholder="Order reference"
            className={`${inputClass} mt-0 w-44`}
          />
          <button className="rounded-md border border-slate-300 bg-white px-3 text-sm">Find</button>
        </form>
      </div>
      {page.rows.length === 0 ? (
        <Empty>No order calls here yet.</Empty>
      ) : (
        <Table head={['Order', 'Customer', 'Status', 'Outcome', 'Value', 'Attempts', 'Received']}>
          {page.rows.map((r) => (
            <tr key={r.id}>
              <Td>
                <TextLink href={`/app/orders/${r.id}`}>{r.orderRef}</TextLink>
                <div className="text-xs text-slate-500">{humanise(r.useCase)}</div>
              </Td>
              <Td className="font-mono text-xs">{r.phone}</Td>
              <Td>
                <Badge tone={r.status.tone} title={r.status.explanation}>
                  {r.status.label}
                </Badge>
                {r.gated === null ? null : (
                  <div className="mt-1 max-w-56 whitespace-normal text-xs text-amber-800">
                    {r.gated.title}
                  </div>
                )}
              </Td>
              <Td>
                {r.outcome === null ? (
                  '—'
                ) : (
                  <Badge tone={r.outcome.tone} title={r.outcome.explanation}>
                    {r.outcome.label}
                  </Badge>
                )}
                {r.billable === true ? (
                  <div className="mt-1 text-xs text-slate-500">Billable</div>
                ) : null}
              </Td>
              <Td>{formatMoney(r.valueMinor, r.currency)}</Td>
              <Td>{r.attempts}</Td>
              <Td>{formatDateTime(r.createdAt, tz)}</Td>
            </tr>
          ))}
        </Table>
      )}
      <Pager next={page.next} base={base} />
    </div>
  );
}
