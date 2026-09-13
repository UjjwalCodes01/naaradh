import Link from 'next/link';

export default function Home() {
  return (
    <div className="space-y-12">
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
          Your store’s phone line, answered. Your COD orders, confirmed.
        </h1>
        <p className="max-w-2xl text-slate-600">
          Naaradh is an AI voice agent for commerce. It answers customer calls 24/7 — order status,
          delivery, returns policy, cancelling an unshipped COD order after a two-step confirmation
          — and calls new COD orders within minutes to confirm them before they ship. Built around
          Indian telecom rules: calling windows, consent, do-not-call and disclosure are enforced in
          the product, not left to you.
        </p>
        <div className="flex gap-3">
          <Link
            href="/pricing"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            See pricing
          </Link>
          <Link
            href="/app"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            Sign in
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          [
            'Support line',
            'Answers every call in Hindi, English or Hinglish. Verifies the caller before discussing an order. Hands over to your team, inside your hours, when it should.',
          ],
          [
            'COD confirmation',
            'Calls within minutes of the order, inside 09:00–21:00 IST only. Confirmed and cancelled orders are tagged in Shopify before you ship.',
          ],
          [
            'Pay for results',
            'Outbound is billed only when a person gives a definitive answer. Support calls are billed per connected minute.',
          ],
        ].map(([title, body]) => (
          <div key={title} className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="font-semibold text-slate-900">{title}</h2>
            <p className="mt-2 text-sm text-slate-600">{body}</p>
          </div>
        ))}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">
        <h2 className="font-semibold text-slate-900">Every call starts the same way</h2>
        <p className="mt-2">
          The agent says it is an automated assistant and that the call is recorded, before anything
          else. Anyone can stop all calls from businesses using Naaradh on the{' '}
          <Link href="/do-not-call" className="text-indigo-700 underline">
            do-not-call page
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
