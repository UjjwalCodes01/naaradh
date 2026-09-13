import {
  ATTESTATION_STATEMENT,
  listProfiles,
  listTransferTargets,
  type ProfileView,
  type TransferTargetView,
} from '@naaradh/pipeline';
import { DEFAULT_CLOSED_MESSAGES, DEFAULT_INBOUND_GREETINGS, TOOL_NAMES } from '@naaradh/scripts';
import { ActionForm } from '@/components/action-form';
import { Badge, Card, Label, PageHeader, Table, Td, inputClass } from '@/components/ui';
import { humanise } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import {
  addTransferTarget,
  deactivateTransferTargetAction,
  saveProfile,
  setProfileStatusAction,
  verifyTransferTargetAction,
} from './actions';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const TOOL_HELP: Record<string, string> = {
  lookup_orders: 'Look up the caller’s orders (only after verification)',
  verify_caller: 'Verify a caller by order number + pincode',
  search_knowledge: 'Answer from your published knowledge base',
  confirm_order: 'Let a verified caller confirm a pending COD order',
  request_cancellation: 'Cancel an unshipped COD order after a two-step confirmation',
  request_address_change: 'Take an address change as a ticket (never written automatically)',
  create_ticket: 'Create a ticket for your team',
  transfer_to_human: 'Transfer to a verified number inside its hours',
  register_opt_out: 'Record “don’t call me” requests',
};

export default async function Agent() {
  const s = await requireSession('manager');
  const [profiles, targets] = await inTenant(
    s,
    async (tx) =>
      [await listProfiles(tx, s.tenantId), await listTransferTargets(tx, s.tenantId)] as const,
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Support agent"
        description="Who answers your support line, what it may do, and where calls go when it should not take them. The greeting must say it is an automated assistant and that the call is recorded — profiles without that cannot be activated."
      />
      {profiles.map((p) => (
        <Card key={p.id}>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">{p.name}</h2>
            <Badge tone={p.status === 'active' ? 'good' : 'neutral'}>{p.status}</Badge>
            <span className="text-xs text-slate-500">
              version {p.version} · {p.locale}
            </span>
            <div className="ml-auto">
              <ActionForm
                action={setProfileStatusAction}
                submit={p.status === 'active' ? 'Disable' : 'Activate'}
                danger={p.status === 'active'}
              >
                <input type="hidden" name="id" value={p.id} />
                <input
                  type="hidden"
                  name="status"
                  value={p.status === 'active' ? 'disabled' : 'active'}
                />
              </ActionForm>
            </div>
          </div>
          <details>
            <summary className="cursor-pointer text-sm font-medium text-slate-700">Edit</summary>
            <div className="mt-4">
              <ProfileForm profile={p} targets={targets} />
            </div>
          </details>
        </Card>
      ))}
      <Card title={profiles.length === 0 ? 'Set up your support agent' : 'New profile'}>
        <ProfileForm targets={targets} />
      </Card>
      <Card title="Transfer numbers">
        <p className="mb-3 text-sm text-slate-600">
          The agent can hand a call only to these numbers, only after they are verified, and only
          inside their hours. A caller can never give it a number to call.
        </p>
        {targets.length === 0 ? null : <TargetsTable targets={targets} />}
        <ActionForm action={addTransferTarget} submit="Add number" className="mt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              name="label"
              required
              maxLength={80}
              placeholder="Label, e.g. Support desk"
              className={inputClass}
            />
            <input
              name="phone"
              type="tel"
              required
              placeholder="Staff phone number"
              className={inputClass}
            />
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}

function TargetsTable({ targets }: { targets: TransferTargetView[] }) {
  return (
    <Table head={['Label', 'Number', 'Status', '']}>
      {targets.map((t) => (
        <tr key={t.id}>
          <Td>{t.label}</Td>
          <Td className="font-mono text-xs">{t.phone}</Td>
          <Td>
            {!t.active ? (
              <Badge>Inactive</Badge>
            ) : t.verified_at === null ? (
              <Badge tone="warning">Not verified</Badge>
            ) : (
              <Badge tone="good">Verified</Badge>
            )}
          </Td>
          <Td>
            {t.active && t.verified_at === null ? (
              <ActionForm action={verifyTransferTargetAction} submit="Verify">
                <input type="hidden" name="id" value={t.id} />
                <label className="flex max-w-md items-start gap-2 whitespace-normal text-xs text-slate-600">
                  <input type="checkbox" name="attest" required className="mt-0.5" />
                  {ATTESTATION_STATEMENT}
                </label>
              </ActionForm>
            ) : null}
            {t.active ? (
              <ActionForm
                action={deactivateTransferTargetAction}
                submit="Deactivate"
                danger
                confirm="Stop transferring calls to this number?"
              >
                <input type="hidden" name="id" value={t.id} />
              </ActionForm>
            ) : null}
          </Td>
        </tr>
      ))}
    </Table>
  );
}

function ProfileForm({
  profile,
  targets,
}: {
  profile?: ProfileView;
  targets: TransferTargetView[];
}) {
  const p = profile;
  const pid = p?.id ?? 'new';
  const hours = (p?.business_hours ?? {
    zone: 'Asia/Kolkata',
    days: [1, 2, 3, 4, 5, 6],
    open: '10:00',
    close: '19:00',
  }) as {
    zone: string;
    days: number[];
    open: string;
    close: string;
  };
  const locale = (p?.locale ?? 'en-IN') as 'en-IN' | 'hi-IN';
  return (
    <ActionForm action={saveProfile} submit={p === undefined ? 'Create draft' : 'Save new version'}>
      {p === undefined ? null : <input type="hidden" name="id" value={p.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`name-${pid}`}>Name</Label>
          <input
            id={`name-${pid}`}
            name="name"
            required
            maxLength={80}
            defaultValue={p?.name ?? 'Support line'}
            className={inputClass}
          />
        </div>
        <div>
          <Label htmlFor={`locale-${pid}`}>Language</Label>
          <select id={`locale-${pid}`} name="locale" defaultValue={locale} className={inputClass}>
            <option value="en-IN">English (India)</option>
            <option value="hi-IN">Hindi / Hinglish</option>
          </select>
        </div>
      </div>
      <div>
        <Label
          htmlFor={`greeting-${pid}`}
          hint="First words of every call. Must say it is an automated assistant and that the call is recorded. {{brand}} is your store name."
        >
          Greeting
        </Label>
        <textarea
          id={`greeting-${pid}`}
          name="greeting"
          required
          rows={2}
          defaultValue={p?.greeting ?? DEFAULT_INBOUND_GREETINGS[locale]}
          className={inputClass}
        />
      </div>
      <div>
        <Label
          htmlFor={`persona-${pid}`}
          hint="Optional: tone and style, e.g. “warm, brief, uses the caller’s name”."
        >
          Persona
        </Label>
        <input
          id={`persona-${pid}`}
          name="persona"
          maxLength={300}
          defaultValue={p?.persona ?? ''}
          className={inputClass}
        />
      </div>
      <div>
        <Label
          htmlFor={`facts-${pid}`}
          hint="Up to 20 short facts, one per line: delivery times, COD charges, store hours."
        >
          Pinned facts
        </Label>
        <textarea
          id={`facts-${pid}`}
          name="pinned_facts"
          rows={4}
          defaultValue={p?.pinned_facts.join('\n') ?? ''}
          className={inputClass}
        />
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-slate-800">What the agent may do</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {TOOL_NAMES.map((t) => (
            <label key={t} className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                name="tools"
                value={t}
                defaultChecked={
                  p === undefined ? t !== 'request_cancellation' : p.tools_enabled.includes(t)
                }
                className="mt-1"
              />
              <span>
                <span className="font-medium">{humanise(t)}</span>
                <span className="block text-xs text-slate-500">{TOOL_HELP[t]}</span>
              </span>
            </label>
          ))}
        </div>
        <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="agent_cancel_enabled"
            defaultChecked={p?.agent_cancel_enabled ?? false}
            className="mt-1"
          />
          <span>
            Allow the agent to cancel orders
            <span className="block text-xs text-slate-500">
              Only unshipped COD orders, only for a verified caller, only after reading the order
              back and a second confirmation. Off by default.
            </span>
          </span>
        </label>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="col-span-full text-sm font-medium text-slate-800">
          Business hours (for transfers and the closed message)
        </legend>
        <input
          name="zone"
          defaultValue={hours.zone}
          className={inputClass}
          aria-label="Time zone"
        />
        <input
          name="open"
          type="time"
          defaultValue={hours.open}
          className={inputClass}
          aria-label="Opens"
        />
        <input
          name="close"
          type="time"
          defaultValue={hours.close}
          className={inputClass}
          aria-label="Closes"
        />
        <div className="flex flex-wrap gap-2 text-xs">
          {DAYS.map((d, i) => (
            <label key={d} className="flex items-center gap-1">
              <input
                type="checkbox"
                name="days"
                value={i + 1}
                defaultChecked={hours.days.includes(i + 1)}
              />
              {d}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <Label htmlFor={`closed-${pid}`} hint="{{hours}} is replaced with your hours.">
          Closed message
        </Label>
        <textarea
          id={`closed-${pid}`}
          name="closed_message"
          required
          rows={2}
          defaultValue={p?.closed_message ?? DEFAULT_CLOSED_MESSAGES[locale]}
          className={inputClass}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label
            htmlFor={`fallback-${pid}`}
            hint={
              p?.fallback_forward === null || p === undefined
                ? 'Where calls go when the agent cannot answer.'
                : `Current: ${p.fallback_forward}. Leave blank to keep it.`
            }
          >
            Fallback number
          </Label>
          <input id={`fallback-${pid}`} name="fallback_phone" type="tel" className={inputClass} />
        </div>
        <div>
          <Label htmlFor={`target-${pid}`}>Transfer to</Label>
          <select
            id={`target-${pid}`}
            name="transfer_target_id"
            defaultValue={p?.transfer_target_id ?? ''}
            className={inputClass}
          >
            <option value="">No transfers</option>
            {targets
              .filter((t) => t.active)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label} ({t.phone}){t.verified_at === null ? ' — not verified' : ''}
                </option>
              ))}
          </select>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <NumberField
          name="max_duration_sec"
          label="Max call length (s)"
          value={p?.max_duration_sec ?? 600}
          min={60}
          max={1800}
        />
        <NumberField
          name="max_concurrent"
          label="Calls at once"
          value={p?.max_concurrent ?? 2}
          min={1}
          max={100}
        />
        <NumberField
          name="max_calls_per_caller_hour"
          label="Calls per caller per hour"
          value={p?.max_calls_per_caller_hour ?? 6}
          min={1}
          max={60}
        />
        <NumberField
          name="monthly_minute_cap"
          label="Monthly minute cap"
          value={p?.monthly_minute_cap ?? null}
          min={1}
          max={1_000_000}
        />
      </div>
    </ActionForm>
  );
}

function NumberField({
  name,
  label,
  value,
  min,
  max,
}: {
  name: string;
  label: string;
  value: number | null;
  min: number;
  max: number;
}) {
  return (
    <label className="text-xs font-medium text-slate-700">
      {label}
      <input
        name={name}
        type="number"
        min={min}
        max={max}
        defaultValue={value ?? ''}
        className={inputClass}
      />
    </label>
  );
}
