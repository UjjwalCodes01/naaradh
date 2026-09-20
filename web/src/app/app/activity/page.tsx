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
