import { abTestMetrics, listScripts, type AbTestView, type ScriptView } from '@naaradh/pipeline';
import { ActionForm } from '@/components/action-form';
import { Badge, Card, Empty, Label, PageHeader, inputClass } from '@/components/ui';
import { formatDate, humanise } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';
import { approveScriptAction, endAbTestAction, startAbTestAction } from './actions';

const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);

function TemplateField({ sc, country }: { sc: ScriptView; country: string }) {
  if (!sc.promotional || country !== 'IN') return null;
  return (
    <div>
      <Label
        htmlFor={`dlt-${sc.id}`}
        hint="Promotional calls in India must use wording registered as a DLT content template. Enter the template ID this exact wording was registered under; it is recorded on every call."
      >
        DLT content template ID
      </Label>
      <input
        id={`dlt-${sc.id}`}
        name="dlt_template_id"
        className={inputClass}
        inputMode="numeric"
        pattern="[0-9]{12,25}"
        defaultValue={sc.dltTemplateId ?? ''}
        required
      />
    </div>
  );
}

function AbResults({ test }: { test: AbTestView }) {
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">A/B test · {humanise(test.useCase)}</h2>
        <span className="text-xs text-slate-500">{test.locale}</span>
        {test.leader === null ? (
          <Badge>
            {test.pValue === null
              ? `needs ${String(test.minAnsweredPerArm)} answered calls per version`
              : 'no clear winner yet'}
          </Badge>
        ) : (
          <Badge tone="good">
            version {test.leader} is ahead (p = {test.pValue?.toFixed(3)})
          </Badge>
        )}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-slate-500">
            <th className="py-1">Version</th>
            <th>Dialled</th>
            <th>Answered</th>
            <th>Positive</th>
            <th>Opt-outs</th>
            <th>Complaints</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {test.arms.map((a) => (
            <tr key={a.scriptId} className="border-t border-slate-100">
              <td className="py-2">
                {a.arm} · v{a.version}
              </td>
              <td>{a.dialled}</td>
              <td>
                {a.answered} <span className="text-xs text-slate-500">{pct(a.answerRate)}</span>
              </td>
              <td>
                {a.positive} <span className="text-xs text-slate-500">{pct(a.positiveRate)}</span>
              </td>
              <td>
                {a.optOuts} <span className="text-xs text-slate-500">{pct(a.optOutRate)}</span>
              </td>
              <td>{a.complaints > 0 ? <Badge tone="bad">{a.complaints}</Badge> : 0}</td>
              <td>
                <ActionForm
                  action={endAbTestAction}
                  submit={`Keep ${a.arm}`}
                  confirm={`End the test and keep version ${a.arm}? The other version is retired.`}
                >
                  <input type="hidden" name="keep" value={a.scriptId} />
                </ActionForm>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-slate-500">
        Each call hears one version, chosen by the call so retries hear the same one. Positive =
        confirmed, booked, will complete, feedback given and similar. A version with more opt-outs
        or any complaint should be stopped whatever its positive rate.
      </p>
    </Card>
  );
}

export default async function Scripts() {
  const s = await requireSession('manager');
  const t = await tenantSettings();
  const [scripts, tests] = await inTenant(s, async (tx) => [
    await listScripts(tx, s.tenantId),
    await abTestMetrics(tx, s.tenantId),
  ]);
  const testing = new Set(tests.map((x) => `${x.useCase}:${x.locale}`));
  return (
    <div className="space-y-4">
      <PageHeader
        title="Call scripts"
        description="What the agent says on outbound calls. Only an approved version is used; approving runs the disclosure check again and records who approved it. You can test a draft against the live version (A/B)."
      />
      {tests.map((x) => (
        <AbResults key={`${x.useCase}:${x.locale}`} test={x} />
      ))}
      {scripts.length === 0 ? (
        <Empty>No scripts yet. Naaradh prepares them during onboarding.</Empty>
      ) : null}
      {scripts.map((sc) => {
        const live = scripts.some(
          (o) => o.useCase === sc.useCase && o.locale === sc.locale && o.status === 'approved',
        );
        const underTest = testing.has(`${sc.useCase}:${sc.locale}`);
        return (
          <Card key={sc.id}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">{humanise(sc.useCase)}</h2>
              <span className="text-xs text-slate-500">
                {sc.locale} · version {sc.version}
              </span>
              <Badge tone={sc.status === 'approved' ? 'good' : 'neutral'}>{sc.status}</Badge>
              {sc.abArm === null ? null : <Badge tone="warning">A/B version {sc.abArm}</Badge>}
              {sc.promotional ? <Badge>promotional</Badge> : null}
              {sc.approvedAt === null ? null : (
                <span className="text-xs text-slate-500">
                  approved {formatDate(sc.approvedAt, t.timezone)}
                </span>
              )}
              {sc.dltTemplateId === null ? null : (
                <span className="text-xs text-slate-500">DLT template {sc.dltTemplateId}</span>
              )}
            </div>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-xs uppercase text-slate-500">Opening</dt>
                <dd>{sc.opening}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-slate-500">Purpose</dt>
                <dd>{sc.purposeLine}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-slate-500">Closing</dt>
                <dd>{sc.closing}</dd>
              </div>
            </dl>
            {sc.problems === null ? null : (
              <p className="mt-3 text-sm text-rose-700">Cannot be approved: {sc.problems}</p>
            )}
            {sc.status === 'draft' && sc.problems === null && underTest ? (
              <p className="mt-3 text-sm text-slate-600">
                A test is running for this script and language. End it before approving or testing
                another version.
              </p>
            ) : null}
            {sc.status === 'draft' && sc.problems === null && !underTest ? (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <ActionForm action={approveScriptAction} submit="Approve this version">
                  <input type="hidden" name="id" value={sc.id} />
                  <TemplateField sc={sc} country={t.country} />
                </ActionForm>
                {live ? (
                  <ActionForm action={startAbTestAction} submit="Test against the live version">
                    <input type="hidden" name="id" value={sc.id} />
                    <TemplateField sc={sc} country={t.country} />
                  </ActionForm>
                ) : null}
              </div>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
