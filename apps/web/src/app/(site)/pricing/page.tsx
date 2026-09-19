import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { PLANS, type Plan } from '@naaradh/pipeline';
import { LINKS } from '@/lib/site-links';
import { rupees } from '@/lib/money';
import {
  BuildingIcon,
  CheckIcon,
  GaugeIcon,
  PlusIcon,
  RupeeIcon,
  ShieldIcon,
  TagIcon,
  UsersIcon,
} from '@/components/site/icons';
import { PlanPicker, type FamilyView, type TierView } from '@/components/site/plan-picker';
import { Button, CARD, Eyebrow, IconChip, WRAP } from '@/components/site/ui';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Simple monthly plans for COD confirmation calls and a 24/7 AI support line. Billed only on a clear answer or a connected minute. Prices in INR, excluding GST.',
};

/**
 * naaradh.com/pricing. Rendered from the same plan catalogue the ledger bills from (ADR-0008),
 * so no price, allowance or rate on this page can drift from what a merchant is charged.
 *
 * The two products are priced separately (confirmation calls per confirmed outcome, the support
 * line per connected minute), which is why the plan cards switch between two price books and
 * the comparison table shows both.
 */

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const TIERS = ['Starter', 'Growth', 'Scale'] as const;

const TAGLINES: Record<(typeof TIERS)[number], string> = {
  Starter: 'Perfect for small stores getting started.',
  Growth: 'For growing brands with higher volume.',
  Scale: 'For high-volume brands.',
};

const SUPPORT: Record<(typeof TIERS)[number], string> = {
  Starter: 'Email support',
  Growth: 'Priority support',
  Scale: 'Priority support',
};

function plan(code: string): Plan {
  const p = PLANS[code];
  if (p === undefined) throw new Error(`plan catalogue is missing ${code}`);
  return p;
}

const OUTBOUND = [plan('starter'), plan('growth'), plan('scale')] as const;
const INBOUND = [plan('inbound_starter'), plan('inbound_growth'), plan('inbound_scale')] as const;

const count = (n: number) => n.toLocaleString('en-IN');

/** "150 confirmed outcomes / month" or "500 connected minutes / month". */
function allowance(p: Plan): string {
  const n = count(p.prices.INR.includedUnits);
  return p.unit === 'outcome'
    ? `${n} confirmed outcomes / month`
    : `${n} connected minutes / month`;
}

function overage(p: Plan): string {
  return `${rupees(p.prices.INR.unitMinor)} per ${p.unit === 'outcome' ? 'outcome' : 'minute'} after that`;
}

function tiersFor(plans: readonly Plan[], starterExtras: readonly string[]): TierView[] {
  return plans.map((p, i) => {
    const tier = TIERS[i] ?? 'Starter';
    const previous = TIERS[i - 1];
    const features =
      previous === undefined
        ? [allowance(p), overage(p), ...starterExtras, SUPPORT[tier]]
        : [`Everything in ${previous}`, allowance(p), overage(p), SUPPORT[tier]];
    return {
      code: p.code,
      name: tier,
      tagline: TAGLINES[tier],
      fee: rupees(p.prices.INR.feeMinor),
      features,
      cta:
        tier === 'Scale'
          ? { href: LINKS.talkToUs, label: 'Talk to us', primary: false }
          : { href: LINKS.shopifyInstall, label: 'Install on Shopify', primary: true },
      popular: tier === 'Growth',
    };
  });
}

const FAMILIES: readonly FamilyView[] = [
  {
    key: 'outbound',
    label: 'COD confirmation',
    note: 'Order confirmation, cart recovery and feedback calls. Billed per confirmed outcome.',
    tiers: tiersFor(OUTBOUND, [
      'COD confirmation calls, plus cart recovery & feedback calls with consent',
      'Billed only when the customer gives a clear answer',
      'Dashboard, call logs & recordings',
    ]),
  },
  {
    key: 'inbound',
    label: 'Support line',
    note: 'Your store’s phone line, answered 24/7. Billed per connected minute.',
    tiers: tiersFor(INBOUND, [
      'Answers your store line 24/7',
      'Order status, policies & tickets',
      'Hands over to your team in working hours',
    ]),
  },
];

const PROMISES: readonly { Icon: Icon; title: string; body: string }[] = [
  { Icon: TagIcon, title: 'No setup fee', body: 'Get started in minutes.' },
  { Icon: RupeeIcon, title: 'Pay for results', body: 'Clear answers and connected minutes only.' },
  {
    Icon: GaugeIcon,
    title: 'Your spending cap',
    body: 'Calls pause at the cap. No surprise bills.',
  },
  { Icon: ShieldIcon, title: 'Compliant by design', body: 'Built for Indian calling rules.' },
];

/** Features every plan has. Nothing below is gated by tier: plans differ in volume and support. */
const EVERY_PLAN = [
  'Hindi, English & Hinglish',
  'AI and recording disclosure on every call',
  'DND and calling-hours checks',
  'Monthly spending cap',
  'Shopify, WooCommerce & REST API',
] as const;

const FAQS = [
  {
    q: 'Are there any setup fees?',
    a: 'No. You pay the monthly plan fee and, beyond your allowance, the per-outcome or per-minute rate. Nothing else.',
  },
  {
    q: 'Can I change my plan later?',
    a: 'Yes. You can move between plans from the Billing page in your dashboard, and add or drop the support line separately from confirmation calls.',
  },
  {
    q: 'What happens if I go over my allowance?',
    a: 'Calls carry on at the per-outcome or per-minute rate shown on your plan, until the monthly spending cap you set. At the cap, confirmation calls pause and support calls forward to your own number. Nothing is charged above the cap.',
  },
  {
    q: 'What exactly counts as a confirmed outcome?',
    a: 'A call where a person answered and gave a definitive answer: confirmed, confirmed with changes, cancelled, rescheduled or booked. No answer, voicemail, a wrong number, an opt-out or an unclear call is never billed.',
  },
  {
    q: 'Is GST included in the pricing?',
    a: 'No. Prices are in INR and exclude GST, which is added to your invoice. Shopify stores are billed through Shopify; other Indian merchants through Razorpay.',
  },
] as const;

/* ---- small pieces ------------------------------------------------------------ */

function Tick({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-center gap-2.5 text-[14.5px] text-body xl:text-[15.5px]">
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-forest-500 text-white">
        <CheckIcon className="h-3 w-3" />
      </span>
      {children}
    </li>
  );
}

function Yes() {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-forest-500 text-white">
      <CheckIcon className="h-3 w-3" />
      <span className="sr-only">Included</span>
    </span>
  );
}

/** One row of the comparison table: a label and three cells, Growth's shaded. */
function Row({ label, cells }: { label: string; cells: readonly ReactNode[] }) {
  return (
    <tr className="border-t border-line-soft">
      <th scope="row" className="py-3.5 pr-4 pl-6 text-left text-[14.5px] font-medium text-ink/80">
        {label}
      </th>
      {cells.map((cell, i) => (
        <td
          key={i}
          className={`px-4 py-3.5 text-center text-[14.5px] text-ink ${i === 1 ? 'bg-sage-100' : ''}`}
        >
          {cell}
        </td>
      ))}
    </tr>
  );
}

function GroupRow({ label }: { label: string }) {
  return (
    <tr className="border-t border-line-soft">
      <th
        scope="colgroup"
        colSpan={4}
        className="bg-cream-200/60 py-2.5 pl-6 text-left text-[12px] font-bold tracking-[0.12em] text-forest uppercase"
      >
        {label}
      </th>
    </tr>
  );
}

/* ---- the page ---------------------------------------------------------------- */

export default function Pricing() {
  return (
    <>
      {/* ---- hero ---------------------------------------------------------------- */}
      <section className="flex min-h-[calc(100svh-72px)] items-center overflow-x-clip py-10 lg:py-12">
        <div
          className={`${WRAP} grid grid-cols-[minmax(0,1fr)] items-center gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]`}
        >
          <div>
            <Eyebrow>Pricing</Eyebrow>
            <h1 className="mt-6 text-[2.7rem] leading-[1.05] font-extrabold tracking-[-0.03em] text-ink sm:text-[3.6rem] lg:text-[3.2rem] xl:text-[3.8rem] 2xl:text-[4.4rem]">
              Simple pricing
              <br />
              for <span className="text-leaf">growing brands.</span>
            </h1>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-body xl:text-[19px]">
              Transparent, predictable and fair. Choose a plan that fits your store. You pay for
              results: clear answers on confirmation calls, connected minutes on the support line.
            </p>
            <ul className="mt-8 flex flex-wrap gap-x-7 gap-y-3">
              <Tick>No setup fees</Tick>
              <Tick>Monthly billing, no contract</Tick>
              <Tick>Set your own spending cap</Tick>
            </ul>
          </div>
          <Image
            src="/pricing-hero.png"
            alt="A customer smiling on a call from Naaradh confirming her order."
            width={1359}
            height={861}
            priority
            sizes="(max-width: 1024px) 100vw, 65vw"
            className="h-auto w-full max-w-none xl:w-[108%] min-[1800px]:w-[114%]"
          />
        </div>
      </section>

      {/* ---- plans --------------------------------------------------------------- */}
      <section className={`${WRAP} pt-6 pb-10`}>
        <PlanPicker families={FAMILIES} />
      </section>

      {/* ---- promises ------------------------------------------------------------ */}
      <section className={`${WRAP} pb-16`}>
        <ul className={`${CARD} grid gap-6 px-7 py-7 sm:grid-cols-2 lg:grid-cols-4 lg:px-10`}>
          {PROMISES.map(({ Icon, title, body }) => (
            <li key={title} className="flex items-center gap-4">
              <IconChip>
                <Icon className="h-6 w-6" />
              </IconChip>
              <span>
                <span className="block text-[15.5px] font-bold text-ink xl:text-[16.5px]">
                  {title}
                </span>
                <span className="mt-0.5 block text-[14px] text-body xl:text-[15px]">{body}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* ---- compare ------------------------------------------------------------- */}
      <section className={`${WRAP} pb-16 sm:pb-24`}>
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,10fr)] lg:gap-14">
          <div>
            <Eyebrow>Plan comparison</Eyebrow>
            <h2 className="mt-5 text-[2.1rem] leading-[1.1] font-extrabold tracking-tight text-ink sm:text-[2.7rem] xl:text-[3.1rem]">
              Compare
              <br className="hidden sm:block" /> plans.
            </h2>
            <p className="mt-5 text-[16px] leading-relaxed text-body xl:text-[17.5px]">
              Every plan includes the full product. Plans differ in how many calls are included, the
              rate after that, and support.
            </p>
          </div>

          <div className={`${CARD} relative overflow-x-auto`}>
            <table className="w-full min-w-[620px] border-collapse">
              <thead>
                <tr>
                  <th scope="col" className="py-4 pl-6 text-left text-[15px] font-bold text-ink">
                    Features
                  </th>
                  {TIERS.map((t, i) => (
                    <th
                      key={t}
                      scope="col"
                      className={`px-4 py-4 text-center text-[15px] font-bold text-ink ${i === 1 ? 'bg-sage-100' : ''}`}
                    >
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <GroupRow label="COD confirmation calls" />
                <Row
                  label="Monthly fee"
                  cells={OUTBOUND.map((p) => rupees(p.prices.INR.feeMinor))}
                />
                <Row
                  label="Confirmed outcomes included"
                  cells={OUTBOUND.map((p) => count(p.prices.INR.includedUnits))}
                />
                <Row
                  label="After that, per outcome"
                  cells={OUTBOUND.map((p) => rupees(p.prices.INR.unitMinor))}
                />
                <GroupRow label="Support line" />
                <Row
                  label="Monthly fee"
                  cells={INBOUND.map((p) => rupees(p.prices.INR.feeMinor))}
                />
                <Row
                  label="Connected minutes included"
                  cells={INBOUND.map((p) => count(p.prices.INR.includedUnits))}
                />
                <Row
                  label="After that, per minute"
                  cells={INBOUND.map((p) => rupees(p.prices.INR.unitMinor))}
                />
                <GroupRow label="Every plan" />
                {EVERY_PLAN.map((feature) => (
                  <Row
                    key={feature}
                    label={feature}
                    cells={[<Yes key="s" />, <Yes key="g" />, <Yes key="c" />]}
                  />
                ))}
                <Row label="Support" cells={TIERS.map((t) => SUPPORT[t].replace(' support', ''))} />
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---- custom + partners --------------------------------------------------- */}
      <section className={`${WRAP} pb-16`}>
        <div
          className={`${CARD} grid gap-10 px-8 py-10 md:grid-cols-2 md:divide-x md:divide-line-soft lg:px-12`}
        >
          <div className="flex items-start gap-6">
            <IconChip size="lg">
              <BuildingIcon className="h-7 w-7" />
            </IconChip>
            <div>
              <h3 className="text-[20px] font-bold text-ink xl:text-[22px]">Need a custom plan?</h3>
              <p className="mt-2 max-w-md text-[15px] leading-relaxed text-body xl:text-[16px]">
                High volume or specific requirements? Enterprise plans add dedicated numbers, a
                custom voice and an SLA.
              </p>
              <div className="mt-6">
                <Button href={LINKS.talkToUs} variant="secondary" arrow>
                  Talk to us
                </Button>
              </div>
            </div>
          </div>
          <div className="flex items-start gap-6 md:pl-10">
            <IconChip size="lg">
              <UsersIcon className="h-7 w-7" />
            </IconChip>
            <div>
              <h3 className="text-[20px] font-bold text-ink xl:text-[22px]">
                For agencies & partners
              </h3>
              <p className="mt-2 max-w-md text-[15px] leading-relaxed text-body xl:text-[16px]">
                Running stores for your clients? Talk to us about pricing across several stores.
              </p>
              <div className="mt-6">
                <Button href={LINKS.talkToUs} variant="secondary" arrow>
                  Get in touch
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---- faq ----------------------------------------------------------------- */}
      <section className={`${WRAP} pb-16 sm:pb-24`}>
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,9fr)] lg:gap-16">
          <div className="lg:max-w-lg">
            <Eyebrow>FAQ</Eyebrow>
            <h2 className="mt-5 text-[2.1rem] leading-[1.1] font-extrabold tracking-tight text-ink sm:text-[2.7rem] xl:text-[3.1rem]">
              Pricing questions,
              <br className="hidden sm:block" /> answered.
            </h2>
            <p className="mt-5 text-[16px] leading-relaxed text-body xl:text-[17.5px]">
              Everything you need to know about our pricing. Refunds are covered in our{' '}
              <Link
                href="/refunds"
                className="font-semibold text-forest underline underline-offset-4"
              >
                refund policy
              </Link>
              .
            </p>
            <div className="mt-9">
              <Button href={LINKS.allFaqs} size="lg" variant="secondary" arrow>
                View all FAQs
              </Button>
            </div>
          </div>

          <div className={`${CARD} overflow-hidden`}>
            {FAQS.map(({ q, a }, index) => (
              <details key={q} className="faq-row border-b border-line-soft last:border-0">
                <summary className="flex cursor-pointer list-none items-center gap-6 px-7 py-6 text-[16px] font-semibold text-ink marker:content-none hover:bg-cream/50 xl:text-[17.5px]">
                  <span className="text-[14px] font-semibold text-muted">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="flex-1">{q}</span>
                  <PlusIcon className="faq-plus h-5 w-5 shrink-0 text-ink transition-transform duration-200" />
                </summary>
                <p className="px-7 pt-0 pb-6 pl-[4.1rem] text-[15px] leading-relaxed text-body xl:text-[16px]">
                  {a}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
