import { listInbound } from '@naaradh/pipeline';
import { Badge, Empty, PageHeader, Pager, Table, Td, TextLink } from '@/components/ui';
import { formatDateTime, formatDuration } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';

type Search = Promise<{ cursor?: string }>;

export default async function SupportCalls({ searchParams }: { searchParams: Search }) {
  const s = await requireSession();
  const tz = (await tenantSettings()).timezone;
  const { cursor } = await searchParams;
  const page = await inTenant(s, (tx) =>
    listInbound(tx, s.tenantId, cursor === undefined ? {} : { cursor }),
  );
  return (
    <div>
      <PageHeader
        title="Support calls"
        description="Customers who rang your support line. The agent only discusses orders once the caller is verified; everything it could not do became a ticket."
      />
      {page.rows.length === 0 ? (
        <Empty>
          No support calls yet. Point your support number at Naaradh from the Support agent page.
        </Empty>
      ) : (
        <Table head={['Call', 'Caller', 'Verified as', 'Outcome', 'Duration', 'Tickets']}>
          {page.rows.map((r) => (
            <tr key={r.id}>
              <Td>
                <TextLink href={`/app/support-calls/${r.id}`}>
                  {formatDateTime(r.startedAt ?? r.createdAt, tz)}
                </TextLink>
              </Td>
              <Td className="font-mono text-xs">{r.caller}</Td>
              <Td>
                <Badge tone={r.identity.tone} title={r.identity.explanation}>
                  {r.identity.label}
                </Badge>
              </Td>
              <Td>
                {r.outcome === null ? '—' : <Badge tone={r.outcome.tone}>{r.outcome.label}</Badge>}
                {r.transferred ? (
                  <div className="mt-1 text-xs text-slate-500">Transferred</div>
                ) : null}
              </Td>
              <Td>{formatDuration(r.durationSec)}</Td>
              <Td>{r.tickets === 0 ? '—' : r.tickets}</Td>
            </tr>
          ))}
        </Table>
      )}
      <Pager next={page.next} base="/app/support-calls" />
    </div>
  );
}
