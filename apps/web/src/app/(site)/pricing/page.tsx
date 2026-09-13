import type { Metadata } from 'next';
import { PLANS, formatMinor, type Plan } from '@naaradh/pipeline';

export const metadata: Metadata = { title: 'Pricing' };

const OUTBOUND = ['starter', 'growth', 'scale'];
const INBOUND = ['inbound_starter', 'inbound_growth', 'inbound_scale'];

/** Rendered from the same plan catalogue the ledger bills from (ADR-0008) — the page cannot drift. */
export default function Pricing() {
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Pricing</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Prices in INR, excluding GST. Shopify stores are billed through Shopify; other Indian
          merchants through Razorpay. You set a monthly spending cap; calls pause at the cap rather
          than surprise you.
        </p>
      </div>
      <PlanTable
        title="COD confirmation and other outbound calls"
        unit="confirmed outcome"
        codes={OUTBOUND}
        note="Billed only when a person answered and gave a definitive answer: confirmed, confirmed with changes, cancelled, rescheduled or booked. No answer, voicemail, wrong number, opt-out or an unclear call is never billed."
      />
      <PlanTable
        title="Support line (inbound)"
        unit="connected minute"
        codes={INBOUND}
        note="Metered per connected minute, rounded up per call. Calls the agent could not take (outside hours, paused, over your cap) forward to your own number and are not billed."
      />
      <p className="text-sm text-slate-600">
        Enterprise: dedicated numbers, custom voice, SLA — write to sales@naaradh.com.
      </p>
    </div>
  );
}

function PlanTable({
  title,
  unit,
  codes,
  note,
}: {
  title: string;
  unit: string;
  codes: readonly string[];
  note: string;
}) {
  const plans = codes.map((c) => PLANS[c]).filter((p): p is Plan => p !== undefined);
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-slate-900">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        {plans.map((p) => {
          const inr = p.prices.INR;
          return (
            <div key={p.code} className="rounded-lg border border-slate-200 bg-white p-5">
              <h3 className="font-semibold text-slate-900">
                {p.name.replace('Support line — ', '')}
              </h3>
              <p className="mt-2 text-2xl font-semibold">
                {formatMinor(inr.feeMinor, 'INR')}
                <span className="text-sm font-normal text-slate-500">/month</span>
              </p>
              <p className="mt-2 text-sm text-slate-600">
                {inr.includedUnits.toLocaleString('en-IN')} included, then{' '}
                {formatMinor(inr.unitMinor, 'INR')} per {unit}
              </p>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-slate-500">{note}</p>
    </section>
  );
}
