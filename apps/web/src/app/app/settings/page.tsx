import { getSettings, listUseCases } from '@naaradh/pipeline';
import { ActionForm } from '@/components/action-form';
import { Badge, Card, Label, PageHeader, inputClass } from '@/components/ui';
import { formatDate, humanise } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { saveSettings, toggleUseCase } from './actions';

const paiseToRupees = (v: number | null) => (v === null ? '' : String(v / 100));

export default async function Settings() {
  const s = await requireSession('manager');
  const [t, useCases] = await inTenant(
    s,
    async (tx) => [await getSettings(tx, s.tenantId), await listUseCases(tx, s.tenantId)] as const,
  );
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />
      <Card title="What Naaradh calls for">
        <ul className="divide-y divide-slate-100">
          {useCases.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-3 py-3">
              <span className="font-medium">{humanise(u.kind)}</span>
              <Badge tone={u.purpose === 'promotional' ? 'warning' : 'neutral'}>{u.purpose}</Badge>
              <Badge tone={u.enabled ? 'good' : 'neutral'}>{u.enabled ? 'On' : 'Off'}</Badge>
              <div className="ml-auto">
                <ActionForm action={toggleUseCase} submit={u.enabled ? 'Turn off' : 'Turn on'}>
                  <input type="hidden" name="id" value={u.id} />
                  <input type="hidden" name="enabled" value={u.enabled ? 'false' : 'true'} />
                </ActionForm>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-slate-500">
          Promotional calls (abandoned carts, feedback) need the customer’s recorded consent and
          your DLT registration; Naaradh refuses them otherwise.
        </p>
      </Card>
      <Card>
        <ActionForm action={saveSettings} submit="Save settings">
          <h2 className="text-sm font-semibold">Business</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="name"
              label="Store name (said on calls as {{brand}})"
              defaultValue={t.name}
              required
            />
            <Field id="legal_name" label="Legal name" defaultValue={t.legal_name ?? ''} />
            <Field
              id="timezone"
              label="Your time zone (for reports)"
              defaultValue={t.timezone}
              required
            />
            <Field id="gstin" label="GSTIN" defaultValue={t.gstin ?? ''} />
            <Field id="pan" label="PAN" defaultValue={t.pan ?? ''} />
            <Field
              id="dlt_pe_id"
              label="DLT Principal Entity ID"
              hint={
                t.dltLinkedAt === null
                  ? 'Not yet linked to Naaradh as telemarketer.'
                  : `Linked ${formatDate(t.dltLinkedAt)}`
              }
              defaultValue={t.dlt_pe_id ?? ''}
            />
          </div>

          <h2 className="pt-4 text-sm font-semibold">Spending and calls</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              id="spend_cap_daily"
              label="Daily spend cap (₹)"
              type="number"
              defaultValue={paiseToRupees(t.spend_cap_daily_paise)}
              hint="Blank = no daily cap"
            />
            <Field
              id="spend_cap_monthly"
              label="Monthly spend cap (₹)"
              type="number"
              defaultValue={paiseToRupees(t.spend_cap_monthly_paise)}
            />
            <Field
              id="retention_days"
              label="Keep recordings (days, 30–365)"
              type="number"
              defaultValue={String(t.retention_days)}
              required
            />
            <Select
              id="amd_mode_transactional"
              label="Answering machine on order calls"
              value={t.amd_mode_transactional}
            />
            <Select
              id="amd_mode_promotional"
              label="Answering machine on promotional calls"
              value={t.amd_mode_promotional}
            />
          </div>

          <h2 className="pt-4 text-sm font-semibold">Store updates</h2>
          <Check
            name="auto_cancel_enabled"
            checked={t.auto_cancel_enabled}
            label="Cancel the Shopify order automatically when the customer cancels on a confirmation call"
            hint="Only when the agent is at least 90% sure. Otherwise the order is tagged for your team. Addresses are never changed automatically."
          />
          <Check
            name="shopify_sync_optout"
            checked={t.shopify_sync_optout}
            label="Mark the customer in Shopify when they ask not to be called"
            hint="Naaradh always stops calling them either way."
          />

          <h2 className="pt-4 text-sm font-semibold">Email to owners and managers</h2>
          <Check
            name="daily_summary"
            checked={t.notifications.daily_summary}
            label="Daily summary at 9:00"
          />
          <Check
            name="gated_digest"
            checked={t.notifications.gated_digest}
            label="Include orders that were not called, and why"
          />
          <p className="text-xs text-slate-500">
            Alerts about complaints, pauses and billing are always sent.
          </p>
        </ActionForm>
      </Card>
    </div>
  );
}

function Field({
  id,
  label,
  defaultValue,
  hint,
  required = false,
  type = 'text',
}: {
  id: string;
  label: string;
  defaultValue: string;
  hint?: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <div>
      {hint === undefined ? (
        <Label htmlFor={id}>{label}</Label>
      ) : (
        <Label htmlFor={id} hint={hint}>
          {label}
        </Label>
      )}
      <input
        id={id}
        name={id}
        type={type}
        defaultValue={defaultValue}
        required={required}
        className={inputClass}
      />
    </div>
  );
}

function Select({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <select id={id} name={id} defaultValue={value} className={inputClass}>
        <option value="continue">Keep talking</option>
        <option value="hangup">Hang up</option>
        <option value="leave_message">Leave a message</option>
      </select>
    </div>
  );
}

function Check({
  name,
  checked,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-2 text-sm text-slate-700">
      <input type="checkbox" name={name} defaultChecked={checked} className="mt-1" />
      <span>
        {label}
        {hint === undefined ? null : <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}
