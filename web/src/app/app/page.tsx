import { overview, usageSummary } from '@naaradh/pipeline';
import { Card, PageHeader, Stat, TextLink } from '@/components/ui';
import { formatMinor } from '@naaradh/pipeline';
import { now } from '@/lib/server';
import { inTenant, requireSession } from '@/lib/session';

export default async function Overview() {
  const s = await requireSession();
  const [ov, usage] = await inTenant(
    s,
    async (tx) =>
      [
        await overview(tx, s.tenantId, now(), 7),
        await usageSummary(tx, s.tenantId, now()),
      ] as const,
  );
  const o = ov.outbound;
  const i = ov.inbound;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Last 7 days"
        description="What Naaradh did for your store, in business terms."
      />
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Orders received" value={o.orders} hint={`${String(o.called)} called`} />
        <Stat
          label="Confirmed"
          value={o.confirmed}
          hint={`${String(o.reachedHuman)} reached a person`}
        />
        <Stat
          label="Cancelled before shipping"
          value={o.cancelledBeforeShip}
          hint="Return-to-origin avoided"
        />
        <Stat
          label="Need your action"
          value={o.needsAction}
          hint="Write-back failed, callback or ticket"
        />
      </section>
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Support calls" value={i.calls} hint={`${String(i.minutes)} minutes`} />
        <Stat label="Resolved by the agent" value={i.resolvedByAgent} />
        <Stat label="Transferred to your team" value={i.transferred} />
        <Stat
          label="Open tickets"
          value={ov.ticketsOpen}
          hint={`${String(i.ticketsCreated)} new this week`}
        />
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Orders not called, and why">
          {o.topGateReasons.length === 0 ? (
            <p className="text-sm text-slate-500">
              Every order was allowed through the compliance checks.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {o.topGateReasons.map((r) => (
                <li key={r.code} className="flex justify-between gap-4">
                  <span>{r.title}</span>
                  <span className="font-medium">{r.count}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-sm">
            <TextLink href="/app/orders?filter=gated">See orders not called →</TextLink>
          </p>
        </Card>
        <Card title={`This month (${usage.period})`}>
          <ul className="space-y-2 text-sm">
            <li className="flex justify-between">
              <span>Billable outcomes</span>
              <span>
                {usage.outbound.used} of {usage.outbound.included} included
              </span>
            </li>
            <li className="flex justify-between">
              <span>Support minutes</span>
              <span>
                {usage.inbound.used} of {usage.inbound.included} included
              </span>
            </li>
            <li className="flex justify-between">
              <span>Charged beyond allowance</span>
              <span>
                {formatMinor(
                  usage.outbound.extraAmountMinor + usage.inbound.extraAmountMinor,
                  usage.currency,
                )}
              </span>
            </li>
          </ul>
          <p className="mt-3 text-sm">
            <TextLink href="/app/billing">Billing details →</TextLink>
          </p>
        </Card>
      </div>
    </div>
  );
}
