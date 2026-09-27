import Link from 'next/link';
import { listActivity } from '@naaradh/pipeline';
import { Empty, PageHeader, Table, Td } from '@/components/ui';
import { formatDateTime, humanise } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';

type Search = Promise<{ all?: string }>;

/** E-74: who listened to which recording, who signed in, who changed what. */
export default async function Activity({ searchParams }: { searchParams: Search }) {
  const s = await requireSession('manager');
  const tz = (await tenantSettings()).timezone;
  const all = (await searchParams).all === '1';
  const rows = await inTenant(s, (tx) =>
    listActivity(tx, s.tenantId, { accessOnly: !all, limit: 200 }),
  );
  return (
    <div>
      <PageHeader
        title="Access log"
        description="Every recording played, transcript read, sign-in and permission change on your account — by your team and by Naaradh."
        actions={
          <Link
            href={all ? '/app/activity' : '/app/activity?all=1'}
            className="text-sm font-medium text-indigo-700 hover:underline"
          >
            {all ? 'Access events only' : 'Show every change'}
          </Link>
        }
      />
      <form
        method="get"
        action="/app/activity/export"
        className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-600">From</span>
          <input type="date" name="from" className="rounded border border-slate-300 px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-600">To</span>
          <input type="date" name="to" className="rounded border border-slate-300 px-2 py-1" />
        </label>
        <button
          type="submit"
          className="rounded bg-slate-900 px-3 py-1.5 font-medium text-white hover:bg-slate-700"
        >
          Download CSV
        </button>
        <span className="text-xs text-slate-500">
          Every change, not just access events. Up to a year at a time; blank means the last 90
          days. The download is itself recorded here.
        </span>
      </form>
      {rows.length === 0 ? (
        <Empty>Nothing yet.</Empty>
      ) : (
        <Table head={['When', 'Who', 'What', 'On']}>
          {rows.map((r) => (
            <tr key={r.id}>
              <Td>{formatDateTime(r.at, tz)}</Td>
              <Td>{r.actor ?? humanise(r.actorType)}</Td>
              <Td>{humanise(r.action)}</Td>
              <Td className="font-mono text-xs">
                {humanise(r.targetType)} {r.targetId ?? ''}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
