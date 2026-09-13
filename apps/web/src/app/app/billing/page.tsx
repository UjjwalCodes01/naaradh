import {
  PLANS,
  formatMinor,
  listDisputes,
  roleAtLeast,
  usageSummary,
  type DirectionUsage,
} from '@naaradh/pipeline';
import { ActionForm } from '@/components/action-form';
import {
  Badge,
  Card,
  DefinitionList,
  Empty,
  PageHeader,
  Table,
  Td,
  inputClass,
} from '@/components/ui';
import { formatDate, humanise } from '@/lib/format';
import { now } from '@/lib/server';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';
import { subscribeRazorpay } from './actions';

export default async function Billing() {
  const s = await requireSession();
  const tz = (await tenantSettings()).timezone;
  const [u, disputes] = await inTenant(
    s,
    async (tx) =>
      [await usageSummary(tx, s.tenantId, now()), await listDisputes(tx, s.tenantId)] as const,
  );
  const canSubscribe =
    roleAtLeast(s.role, 'owner') &&
    u.billingProvider !== 'shopify' &&
    u.subscription?.status !== 'active';
  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        description="Outbound calls are billed only for definitive answers from a person; support calls per connected minute. Your plan’s allowance is used first."
        actions={
          <Badge
            tone={
              u.billingStatus === 'active'
                ? 'good'
                : u.billingStatus === 'none'
                  ? 'neutral'
                  : 'warning'
            }
          >
            {humanise(u.billingStatus)}
          </Badge>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <DirectionCard
          title="Order calls (outcomes)"
          d={u.outbound}
          currency={u.currency}
          unit="outcomes"
        />
        <DirectionCard
          title="Support line (minutes)"
          d={u.inbound}
          currency={u.currency}
          unit="minutes"
        />
      </div>
      <Card title="Subscription">
        {u.subscription === null ? (
          <p className="text-sm text-slate-600">
            {u.billingProvider === 'shopify'
              ? 'Choose a plan from the Naaradh app inside Shopify admin — Shopify bills Shopify stores.'
              : 'No subscription yet.'}
          </p>
        ) : (
          <DefinitionList
            items={[
              ['Billed by', humanise(u.subscription.provider)],
              ['Status', humanise(u.subscription.status)],
              ['Current period ends', formatDate(u.subscription.currentPeriodEnd, tz)],
              [
                'Spending cap this period',
                u.subscription.cappedAmountMinor === null
                  ? '—'
                  : formatMinor(u.subscription.cappedAmountMinor, u.currency),
              ],
              ['Credits this month', formatMinor(u.credits, u.currency)],
              ...(u.graceUntil === null
                ? []
                : [['Payment grace until', formatDate(u.graceUntil, tz)] as [string, string]]),
            ]}
          />
        )}
        {canSubscribe ? (
          <ActionForm
            action={subscribeRazorpay}
            submit="Subscribe with Razorpay"
            className="mt-4 border-t border-slate-100 pt-4"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <select
                name="plan_code"
                defaultValue="growth"
                className={inputClass}
                aria-label="Order-call plan"
              >
                <option value="">No order-call plan</option>
                {['starter', 'growth', 'scale'].map((c) => (
                  <option key={c} value={c}>
                    {PLANS[c]?.name} — {formatMinor(PLANS[c]?.prices.INR.feeMinor ?? 0, 'INR')}
                    /month
                  </option>
                ))}
              </select>
              <select
                name="inbound_plan_code"
                defaultValue=""
                className={inputClass}
                aria-label="Support-line plan"
              >
                <option value="">No support-line plan</option>
                {['inbound_starter', 'inbound_growth', 'inbound_scale'].map((c) => (
                  <option key={c} value={c}>
                    {PLANS[c]?.name} — {formatMinor(PLANS[c]?.prices.INR.feeMinor ?? 0, 'INR')}
                    /month
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-slate-500">
              Prices exclude GST. Razorpay issues GST invoices.
            </p>
          </ActionForm>
        ) : null}
      </Card>
      <Card title="Disputes">
        {disputes.length === 0 ? (
          <Empty>No disputes. Open one from an order call within 7 days of billing.</Empty>
        ) : (
          <Table head={['Opened', 'Status', 'Reason', 'Resolution']}>
            {disputes.map((d) => (
              <tr key={d.id}>
                <Td>{formatDate(d.opened_at, tz)}</Td>
                <Td>
                  <Badge
                    tone={
                      d.status === 'accepted' ? 'good' : d.status === 'rejected' ? 'bad' : 'warning'
                    }
                  >
                    {d.status}
                  </Badge>
                </Td>
                <Td className="max-w-md whitespace-normal">{d.reason}</Td>
                <Td className="max-w-md whitespace-normal">{d.resolution ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function DirectionCard({
  title,
  d,
  currency,
  unit,
}: {
  title: string;
  d: DirectionUsage;
  currency: 'INR' | 'USD';
  unit: string;
}) {
  const pct = d.included === 0 ? 0 : Math.min(100, Math.round((d.used / d.included) * 100));
  return (
    <Card title={title}>
      <p className="text-sm text-slate-600">
        {d.plan === null
          ? 'No plan'
          : `${PLANS[d.plan]?.name ?? d.plan} · ${formatMinor(d.feeMinor, currency)}/month`}
      </p>
      <div className="mt-3 h-2 rounded-full bg-slate-100">
        <div className="h-2 rounded-full bg-slate-900" style={{ width: `${String(pct)}%` }} />
      </div>
      <p className="mt-2 text-sm">
        {d.used.toLocaleString('en-IN')} of {d.included.toLocaleString('en-IN')} included {unit}
      </p>
      <p className="mt-1 text-sm text-slate-600">
        Beyond allowance: {d.extra.toLocaleString('en-IN')} × {formatMinor(d.unitMinor, currency)} ={' '}
        {formatMinor(d.extraAmountMinor, currency)}
      </p>
    </Card>
  );
}
