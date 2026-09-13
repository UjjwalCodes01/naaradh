import { listScripts } from '@naaradh/pipeline';
import { ActionForm } from '@/components/action-form';
import { Badge, Card, Empty, PageHeader } from '@/components/ui';
import { formatDate, humanise } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';
import { approveScriptAction } from './actions';

export default async function Scripts() {
  const s = await requireSession('manager');
  const tz = (await tenantSettings()).timezone;
  const scripts = await inTenant(s, (tx) => listScripts(tx, s.tenantId));
  return (
    <div className="space-y-4">
      <PageHeader
        title="Call scripts"
        description="What the agent says on outbound calls. Only an approved version is used; approving runs the disclosure check again and records who approved it."
      />
      {scripts.length === 0 ? (
        <Empty>No scripts yet. Naaradh prepares them during onboarding.</Empty>
      ) : null}
      {scripts.map((sc) => (
        <Card key={sc.id}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">{humanise(sc.useCase)}</h2>
            <span className="text-xs text-slate-500">
              {sc.locale} · version {sc.version}
            </span>
            <Badge tone={sc.status === 'approved' ? 'good' : 'neutral'}>{sc.status}</Badge>
            {sc.approvedAt === null ? null : (
              <span className="text-xs text-slate-500">
                approved {formatDate(sc.approvedAt, tz)}
              </span>
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
          {sc.status === 'draft' && sc.problems === null ? (
            <ActionForm action={approveScriptAction} submit="Approve this version" className="mt-4">
              <input type="hidden" name="id" value={sc.id} />
            </ActionForm>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
