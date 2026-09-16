import {
  explainCheckout,
  explainOutcome,
  recoveryReport,
  type MoneyByCurrency,
} from '@naaradh/pipeline';
import { Card, PageHeader, Stat, TextLink } from '@/components/ui';
import { formatMoney } from '@/lib/format';
import { now } from '@/lib/server';
import { inTenant, requireSession } from '@/lib/session';

const RANGES = { '7': 7, '30': 30, '90': 90 } as const;

const money = (rows: readonly MoneyByCurrency[]) =>
  rows.length === 0
    ? formatMoney(0, 'INR')
    : rows.map((r) => formatMoney(r.minor, r.currency)).join(' + ');

/**
 * Recovered revenue and ROI (P4-WEB-2, ADR-0010 §9). Measurement, not an invoice: every number
 * says what it counts, and the COD saving is an estimate from the merchant's own RTO cost.
 */
export default async function Results({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const s = await requireSession();
  const { days: raw } = await searchParams;
  const days = raw !== undefined && raw in RANGES ? RANGES[raw as keyof typeof RANGES] : 30;
  const to = now();
  const from = new Date(to.getTime() - days * 86_400_000);
  const r = await inTenant(s, (tx) => recoveryReport(tx, s.tenantId, from, to));
  const c = r.checkouts;
  return (
    <div className="space-y-6">
      <PageHeader
        title={`Results — last ${String(days)} days`}
        description="What Naaradh's calls did for your store. Recovered orders are measured, not billed."
        actions={
          <div className="flex gap-3 text-sm">
            {Object.keys(RANGES).map((d) => (
              <TextLink key={d} href={`/app/results?days=${d}`}>
                {d} days
              </TextLink>
            ))}
          </div>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Recovered orders"
          value={r.recovered.orders}
          hint={`Placed within ${String(r.recovered.windowHours)} h of a cart call the customer answered`}
        />
        <Stat
          label="Recovered revenue"
          value={money(r.recovered.revenue)}
          hint="Cancelled orders excluded"
        />
        <Stat
          label="COD orders cancelled before shipping"
          value={r.cod.cancelledBeforeShip}
          hint={`${String(r.cod.confirmed)} confirmed`}
        />
        <Stat
          label="Return costs avoided (estimate)"
          value={r.cod.rtoAvoidedMinor === null ? '—' : formatMoney(r.cod.rtoAvoidedMinor, 'INR')}
          hint={
            r.cod.rtoCostPaise === null
              ? 'Set your return cost in Settings to see this'
              : `${String(r.cod.cancelledBeforeShip)} × ${formatMoney(r.cod.rtoCostPaise, 'INR')}`
          }
        />
      </section>

      <Card title="What you paid Naaradh in this period">
        <p className="text-2xl font-semibold">{money(r.charges)}</p>
        <p className="mt-1 text-xs text-slate-500">
          Confirmed outcomes, support-line minutes, fees and credits posted in these dates.
          Recovered carts are never billed. See Billing for the invoice view.
        </p>
      </Card>

      <Card title="Abandoned checkouts">
        {c.total === 0 ? (
          <p className="text-sm text-slate-600">
            No checkouts received. If your store uses a one-click checkout (GoKwik, Shiprocket,
            Magic), Shopify sends no abandoned-checkout events and there is nothing to call (E-14).
          </p>
        ) : (
          <>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[16rem_1fr]">
              <dt className="text-slate-500">Checkouts started</dt>
              <dd>{c.total}</dd>
              <dt className="text-slate-500">…with a phone number</dt>
              <dd>{c.withPhone}</dd>
              <dt className="text-slate-500">…where the customer agreed to calls</dt>
              <dd>{c.withConsent}</dd>
              <dt className="text-slate-500">Finished by the customer, no call</dt>
              <dd>{c.completedByThemselves + c.converted}</dd>
              <dt className="text-slate-500">Recovery call queued</dt>
              <dd>{c.scheduled}</dd>
              <dt className="text-slate-500">Too old to call</dt>
              <dd>{c.expired}</dd>
              <dt className="text-slate-500">Still waiting</dt>
              <dd>{c.waiting}</dd>
            </dl>
            {c.skipped.length === 0 ? null : (
              <>
                <h3 className="mt-4 text-sm font-semibold">Not called, and why</h3>
                <ul className="mt-2 space-y-1 text-sm">
                  {c.skipped.map((k) => (
                    <li key={k.reason}>
                      <span className="font-medium">{k.count}</span> —{' '}
                      {explainCheckout('skipped', k.reason).explanation}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Card>

      <Card title="Cart recovery calls">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[16rem_1fr]">
          <dt className="text-slate-500">Calls queued</dt>
          <dd>{r.calls.intents}</dd>
          <dt className="text-slate-500">Dialled</dt>
          <dd>{r.calls.dialled}</dd>
          <dt className="text-slate-500">Reached a person</dt>
          <dd>{r.calls.answered}</dd>
          <dt className="text-slate-500">Recovered, matched to the cart / the phone</dt>
          <dd>
            {r.recovered.byCheckout} / {r.recovered.byPhone}
            {r.recovered.reversed > 0 ? ` (${String(r.recovered.reversed)} later cancelled)` : ''}
          </dd>
        </dl>
        {r.calls.outcomes.length === 0 ? null : (
          <ul className="mt-4 space-y-1 text-sm">
            {r.calls.outcomes.map((o) => (
              <li key={o.outcome}>
                <span className="font-medium">{o.count}</span> — {explainOutcome(o.outcome).label}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs text-slate-500">
          A recovered order is the last cart call the customer answered before ordering, within your
          window. It is a fair measure, not proof the call caused the order.
        </p>
      </Card>
    </div>
  );
}
