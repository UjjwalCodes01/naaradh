import { notFound } from 'next/navigation';
import {
  DISPUTE_WINDOW_DAYS,
  outboundDetail,
  roleAtLeast,
  type AttemptView,
} from '@naaradh/pipeline';
import { isNaaradhError } from '@naaradh/shared';
import { ActionForm } from '@/components/action-form';
import { Badge, Card, DefinitionList, PageHeader, TextLink, inputClass } from '@/components/ui';
import { formatDateTime, formatDuration, formatMoney, humanise } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';
import { now } from '@/lib/server';
import { disputeOutcome } from '../actions';

type Params = Promise<{ id: string }>;

export default async function OrderCall({ params }: { params: Params }) {
  const s = await requireSession();
  const tz = (await tenantSettings()).timezone;
  const { id } = await params;
  const d = await inTenant(s, (tx) => outboundDetail(tx, s.tenantId, id)).catch(
    (error: unknown) => {
      if (isNaaradhError(error) && error.code === 'NOT_FOUND') notFound();
      throw error;
    },
  );
  const canMedia = roleAtLeast(s.role, 'operator');
  const canDispute = roleAtLeast(s.role, 'manager');
  return (
    <div className="space-y-6">
      <PageHeader
        title={`Order ${d.orderRef}`}
        description={`${humanise(d.useCase)} · ${d.purpose} call · ${d.phone}${d.customerName === null ? '' : ` · ${d.customerName}`}`}
        actions={<Badge tone={d.status.tone}>{d.status.label}</Badge>}
      />
      {d.gate === null ? null : (
        <Card title={`Not called: ${d.gate.title}`} className="border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-900">{d.gate.explanation}</p>
          <p className="mt-2 text-sm font-medium text-amber-900">What to do: {d.gate.hint}</p>
        </Card>
      )}
      <Card title="Order">
        <DefinitionList
          items={[
            ['Orders on this call', d.orderRefs.join(', ')],
            ['Value', formatMoney(d.valueMinor, d.currency)],
            ['Order placed', formatDateTime(d.eventTs, tz)],
            [
              'Allowed calling window',
              `${formatDateTime(d.notBefore, tz)} – ${formatDateTime(d.notAfter, tz)}`,
            ],
            ['Language', d.locale],
            ['Cancelled because', d.cancelReason ?? '—'],
          ]}
        />
      </Card>
      {d.steps.length === 0 ? null : (
        <Card title="Compliance checks">
          <ol className="space-y-1 text-sm">
            {d.steps.map((st) => (
              <li key={`${String(st.step)}-${st.name}`} className="flex gap-3">
                <span className={st.ok ? 'text-emerald-700' : 'text-rose-700'}>
                  {st.ok ? '✓' : '✗'}
                </span>
                <span>{humanise(st.name)}</span>
                {st.reason === null ? null : <span className="text-slate-500">({st.reason})</span>}
              </li>
            ))}
          </ol>
        </Card>
      )}
      {d.attempts.map((a) => {
        const outcome = d.outcomes.find((o) => o.attemptId === a.id);
        const disputable =
          outcome !== undefined &&
          outcome.billedAt !== null &&
          (outcome.chargedMinor ?? 0) > 0 &&
          outcome.dispute === null &&
          now().getTime() - outcome.billedAt.getTime() < DISPUTE_WINDOW_DAYS * 86_400_000;
        return (
          <Card key={a.id} title={`Attempt ${String(a.attemptNo)} · ${humanise(a.status)}`}>
            <AttemptFacts a={a} tz={tz} />
            {outcome === undefined ? null : (
              <div className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={outcome.outcome.tone}>{outcome.outcome.label}</Badge>
                  <span className="text-slate-500">confidence {outcome.confidence.toFixed(2)}</span>
                  <Badge tone={outcome.writeback.tone} title={outcome.writeback.explanation}>
                    {outcome.writeback.label}
                  </Badge>
                  {outcome.billable ? (
                    <Badge tone="neutral">
                      Billed{' '}
                      {outcome.chargedMinor === 0
                        ? '(within allowance)'
                        : formatMoney(outcome.chargedMinor, outcome.chargeCurrency)}
                    </Badge>
                  ) : (
                    <Badge tone="neutral" title={outcome.billableReason}>
                      Not billed
                    </Badge>
                  )}
                  {outcome.dispute === null ? null : (
                    <Badge tone="warning">Dispute {outcome.dispute.status}</Badge>
                  )}
                </div>
                <p className="text-slate-600">{outcome.outcome.explanation}</p>
                {Object.keys(outcome.details).length === 0 ? null : (
                  <DefinitionList
                    items={Object.entries(outcome.details).map(([k, v]) => [
                      humanise(k),
                      String(v),
                    ])}
                  />
                )}
                {outcome.writeback.error === null ? null : (
                  <p className="text-rose-700">Store update error: {outcome.writeback.error}</p>
                )}
                {disputable && canDispute ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-medium text-slate-700">
                      Dispute this charge
                    </summary>
                    <ActionForm action={disputeOutcome} submit="Open dispute" className="mt-3">
                      <input type="hidden" name="outcome_id" value={outcome.id} />
                      <input type="hidden" name="intent_id" value={d.id} />
                      <textarea
                        name="reason"
                        required
                        minLength={10}
                        maxLength={2000}
                        rows={3}
                        className={inputClass}
                        placeholder="What was wrong with this call? e.g. the person who answered was not the customer."
                      />
                    </ActionForm>
                  </details>
                ) : null}
              </div>
            )}
            {canMedia && a.mediaPurgedAt === null && (a.hasRecording || a.hasTranscript) ? (
              <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
                {a.hasRecording ? (
                  // preload="none": nothing is fetched (or audited) until someone presses play.
                  <audio
                    controls
                    preload="none"
                    src={`/app/calls/${a.id}/recording`}
                    className="w-full"
                  />
                ) : null}
                {a.hasTranscript ? (
                  <TextLink href={`/app/calls/${a.id}/transcript`}>Read transcript</TextLink>
                ) : null}
                <p className="text-xs text-slate-500">
                  Listening and reading are recorded in your access log.
                </p>
              </div>
            ) : a.mediaPurgedAt === null ? null : (
              <p className="mt-4 text-xs text-slate-500">
                Recording and transcript deleted on {formatDateTime(a.mediaPurgedAt, tz)} (retention
                setting).
              </p>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function AttemptFacts({ a, tz }: { a: AttemptView; tz: string }) {
  return (
    <DefinitionList
      items={[
        ['Started', formatDateTime(a.startedAt, tz)],
        [
          'Answered',
          a.answeredAt === null
            ? 'Not answered'
            : `${formatDateTime(a.answeredAt, tz)} by ${a.answeredBy ?? 'unknown'}`,
        ],
        ['Duration', formatDuration(a.durationSec)],
        ['Ended because', a.endReason === null ? '—' : humanise(a.endReason)],
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
      ]}
    />
  );
}
