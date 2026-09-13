import { notFound } from 'next/navigation';
import { inboundDetail, roleAtLeast } from '@naaradh/pipeline';
import { isNaaradhError } from '@naaradh/shared';
import {
  Badge,
  Card,
  DefinitionList,
  Empty,
  PageHeader,
  Table,
  Td,
  TextLink,
} from '@/components/ui';
import { formatDateTime, formatDuration, humanise } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';

type Params = Promise<{ id: string }>;

export default async function SupportCall({ params }: { params: Params }) {
  const s = await requireSession();
  const tz = (await tenantSettings()).timezone;
  const { id } = await params;
  const d = await inTenant(s, (tx) => inboundDetail(tx, s.tenantId, id)).catch((error: unknown) => {
    if (isNaaradhError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  });
  const a = d.attempt;
  const canMedia = roleAtLeast(s.role, 'operator');
  return (
    <div className="space-y-6">
      <PageHeader
        title={`Support call · ${formatDateTime(a.startedAt, tz)}`}
        description={`Caller ${d.caller}`}
        actions={
          d.outcome === null ? undefined : (
            <Badge tone={d.outcome.outcome.tone}>{d.outcome.outcome.label}</Badge>
          )
        }
      />
      <Card title="Call">
        <DefinitionList
          items={[
            ['Verified as', `${d.identity.label} — ${d.identity.explanation}`],
            ['Duration', formatDuration(a.durationSec)],
            [
              'Transfer',
              d.transferResult === null ? 'Not transferred' : humanise(d.transferResult),
            ],
            [
              'AI disclosure played',
              a.aiDisclosedAt === null ? 'No record' : formatDateTime(a.aiDisclosedAt, tz),
            ],
            [
              'Recording disclosure played',
              a.recordingDisclosedAt === null
                ? 'No record'
                : formatDateTime(a.recordingDisclosedAt, tz),
            ],
            ['Ended because', a.endReason === null ? '—' : humanise(a.endReason)],
          ]}
        />
      </Card>
      <Card title="What the agent did">
        {d.actions.length === 0 ? (
          <Empty>The agent answered from your knowledge base without using any tools.</Empty>
        ) : (
          <Table head={['Time', 'Tool', 'Result', 'Took']}>
            {d.actions.map((x) => (
              <tr key={x.id}>
                <Td>{formatDateTime(x.at, tz)}</Td>
                <Td>{humanise(x.tool)}</Td>
                <Td>
                  <Badge
                    tone={x.status === 'refused' || x.status === 'failed' ? 'warning' : 'neutral'}
                  >
                    {x.statusLabel}
                  </Badge>
                  {x.ticketId === null ? null : (
                    <span className="ml-2 text-xs text-slate-500">ticket</span>
                  )}
                </Td>
                <Td>{x.latencyMs === null ? '—' : `${String(x.latencyMs)} ms`}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {d.tickets.length === 0 ? null : (
        <Card title="Tickets from this call">
          <ul className="space-y-2 text-sm">
            {d.tickets.map((t) => (
              <li key={t.id} className="flex gap-3">
                <Badge tone={t.status === 'resolved' ? 'good' : 'warning'}>
                  {humanise(t.status)}
                </Badge>
                <span className="font-medium">{humanise(t.category)}</span>
                <span className="text-slate-600">{t.summary}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm">
            <TextLink href="/app/tickets">Open tickets →</TextLink>
          </p>
        </Card>
      )}
      {canMedia && a.mediaPurgedAt === null && (a.hasRecording || a.hasTranscript) ? (
        <Card title="Recording">
          {a.hasRecording ? (
            <audio
              controls
              preload="none"
              src={`/app/calls/${a.id}/recording`}
              className="w-full"
            />
          ) : null}
          {a.hasTranscript ? (
            <p className="mt-2 text-sm">
              <TextLink href={`/app/calls/${a.id}/transcript`}>Read transcript</TextLink>
            </p>
          ) : null}
          <p className="mt-2 text-xs text-slate-500">
            Listening and reading are recorded in your access log.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
