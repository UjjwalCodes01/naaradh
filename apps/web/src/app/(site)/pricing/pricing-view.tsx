import Image from 'next/image';
import Link from 'next/link';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { PLANS, type Plan } from '@naaradh/pipeline';
import { LINKS } from '@/lib/site-links';
import { dollars, rupees } from '@/lib/money';
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

/**
 * naaradh.com/pricing (India, INR) and naaradh.com/pricing/us (United States, USD, P6-GTM-1).
 * Rendered from the same plan catalogue the ledger bills from (ADR-0008), so no price,
 * allowance or rate on either page can drift from what a merchant is charged.
 *
 * The two products are priced separately (confirmation calls per confirmed outcome, the support
 * line per connected minute), which is why the plan cards switch between two price books and
 * the comparison table shows both. The US page shows confirmation calls only: the support line
 * does not answer US numbers yet (Q-31), and US calling itself opens as early access.
 */

export type Market = 'in' | 'us';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const TIERS = ['Starter', 'Growth', 'Scale'] as const;
type Tier = (typeof TIERS)[number];

const TAGLINES: Record<Tier, string> = {
  Starter: 'Perfect for small stores getting started.',
  Growth: 'For growing brands with higher volume.',
  Scale: 'For high-volume brands.',
};

const SUPPORT: Record<Tier, string> = {
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

/** How one market shows its numbers. */
interface Money {
  readonly price: (p: Plan) => Plan['prices']['INR'];
  readonly money: (minor: number) => string;
  readonly count: (n: number) => string;
}

const MONEY: Record<Market, Money> = {
  in: { price: (p) => p.prices.INR, money: rupees, count: (n) => n.toLocaleString('en-IN') },
  us: { price: (p) => p.prices.USD, money: dollars, count: (n) => n.toLocaleString('en-US') },
};

/** "150 confirmed outcomes / month" or "500 connected minutes / month". */
function allowance(m: Money, p: Plan): string {
  const n = m.count(m.price(p).includedUnits);
  return p.unit === 'outcome'
    ? `${n} confirmed outcomes / month`
    : `${n} connected minutes / month`;
}

function overage(m: Money, p: Plan): string {
  return `${m.money(m.price(p).unitMinor)} per ${p.unit === 'outcome' ? 'outcome' : 'minute'} after that`;
}

type Cta = (tier: Tier) => TierView['cta'];

const INSTALL_CTA: Cta = (tier) =>
  tier === 'Scale'
    ? { href: LINKS.talkToUs, label: 'Talk to us', primary: false }
    : { href: LINKS.shopifyInstall, label: 'Install on Shopify', primary: true };

/** US calling opens as early access: every card asks to talk first, none promises an install. */
const EARLY_ACCESS_CTA: Cta = (tier) => ({
  href: LINKS.talkToUs,
  label: 'Request early access',
  primary: tier === 'Growth',
});

function tiersFor(
  m: Money,
  plans: readonly Plan[],
  starterExtras: readonly string[],
  cta: Cta,
): TierView[] {
  return plans.map((p, i) => {
    const tier = TIERS[i] ?? 'Starter';
    const previous = TIERS[i - 1];
    const features =
      previous === undefined
        ? [allowance(m, p), overage(m, p), ...starterExtras, SUPPORT[tier]]
        : [`Everything in ${previous}`, allowance(m, p), overage(m, p), SUPPORT[tier]];
    return {
      code: p.code,
      name: tier,
      tagline: TAGLINES[tier],
      fee: m.money(m.price(p).feeMinor),
      features,
      cta: cta(tier),
      popular: tier === 'Growth',
    };
  });
}

const FAMILIES: Record<Market, readonly FamilyView[]> = {
  in: [
    {
      key: 'outbound',
      label: 'COD confirmation',
      note: 'Order confirmation, cart recovery and feedback calls. Billed per confirmed outcome.',
      tiers: tiersFor(
        MONEY.in,
        OUTBOUND,
        [
          'COD confirmation calls, plus cart recovery & feedback calls with consent',
          'Billed only when the customer gives a clear answer',
          'Dashboard, call logs & recordings',
        ],
        INSTALL_CTA,
      ),
    },
    {
      key: 'inbound',
      label: 'Support line',
      note: 'Your store’s phone line, answered 24/7. Billed per connected minute.',
      tiers: tiersFor(
        MONEY.in,
        INBOUND,
        [
          'Answers your store line 24/7',
          'Order status, policies & tickets',
          'Hands over to your team in working hours',
        ],
        INSTALL_CTA,
      ),
    },
  ],
  us: [
    {
      key: 'outbound',
      label: 'Confirmation calls',
      note: 'Order and appointment confirmations, and cart recovery with the customer’s written consent. Billed per confirmed outcome.',
      tiers: tiersFor(
        MONEY.us,
        OUTBOUND,
        [
          'Order & appointment confirmation calls, plus cart recovery with written consent',
          'Billed only when the customer gives a clear answer',
          'Dashboard & call logs',
        ],
        EARLY_ACCESS_CTA,
      ),
    },
  ],
};

const PROMISES: Record<Market, readonly { Icon: Icon; title: string; body: string }[]> = {
  in: [
    { Icon: TagIcon, title: 'No setup fee', body: 'Get started in minutes.' },
    {
      Icon: RupeeIcon,
      title: 'Pay for results',
      body: 'Clear answers and connected minutes only.',
    },
    {
      Icon: GaugeIcon,
      title: 'Your spending cap',
      body: 'Calls pause at the cap. No surprise bills.',
    },
    { Icon: ShieldIcon, title: 'Compliant by design', body: 'Built for Indian calling rules.' },
  ],
  us: [
    { Icon: TagIcon, title: 'No setup fee', body: 'No contract, billed monthly.' },
    { Icon: CheckIcon, title: 'Pay for results', body: 'Only calls with a clear answer.' },
    {
      Icon: GaugeIcon,
      title: 'Your spending cap',
      body: 'Calls pause at the cap. No surprise bills.',
    },
    {
      Icon: ShieldIcon,
      title: 'Checks on every call',
      body: 'Calling hours, do-not-call and consent.',
    },
  ],
};

/** Features every plan has. Nothing below is gated by tier: plans differ in volume and support. */
const EVERY_PLAN: Record<Market, readonly string[]> = {
  in: [
    'Hindi, English & Hinglish',
    'AI and recording disclosure on every call',
    'DND and calling-hours checks',
    'Monthly spending cap',
    'Shopify, WooCommerce & REST API',
  ],
  us: [
    'English',
    'AI and recording disclosure on every call; recorded only with consent',
    'Do-not-call and calling-hours checks',
    'Monthly spending cap',
    'Shopify, WooCommerce & REST API',
  ],
};

const OUTCOME_FAQ = {
  q: 'What exactly counts as a confirmed outcome?',
  a: 'A call where a person answered and gave a definitive answer: confirmed, confirmed with changes, cancelled, rescheduled or booked. No answer, voicemail, a wrong number, an opt-out or an unclear call is never billed.',
};

const FAQS: Record<Market, readonly { q: string; a: string }[]> = {
  in: [
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
    OUTCOME_FAQ,
    {
      q: 'Is GST included in the pricing?',
      a: 'No. Prices are in INR and exclude GST, which is added to your invoice. Shopify stores are billed through Shopify; other Indian merchants through Razorpay.',
    },
  ],
  us: [
    {
      q: 'When can I start calling US customers?',
      a: 'US calling opens as early access. Before an account goes live we check the numbers your calls come from, load the national do-not-call list, and confirm how your store collects consent. Request early access and we will tell you when your account can start.',
    },
    OUTCOME_FAQ,
    {
      q: 'What happens if I go over my allowance?',
      a: 'Calls carry on at the per-outcome rate shown on your plan, until the monthly spending cap you set. At the cap, calls pause. Nothing is charged above the cap.',
    },
    {
      q: 'How am I billed?',
      a: 'Monthly, in US dollars. Shopify stores are billed through Shopify; other merchants by card through Stripe. There are no setup fees.',
    },
    {
      q: 'Is the AI support line available in the US?',
      a: 'Not yet. The support line answers Indian numbers today; US numbers follow once our US voice partner supports incoming calls.',
    },
  ],
};

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

/** India ↔ United States. Plain links: each page is static and has its own URL. */
function MarketSwitch({ market }: { market: Market }) {
  const item = (m: Market, href: string, label: string) => (
    <Link
      href={href}
      aria-current={m === market ? 'page' : undefined}
      className={`rounded-full px-5 py-2 text-[14px] font-semibold transition-colors ${
        m === market ? 'bg-forest text-cream' : 'text-body hover:text-ink'
      }`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Pricing region" className="flex justify-center">
      <div className="inline-flex rounded-full border border-line bg-white/60 p-1">
        {item('in', '/pricing', 'India · ₹')}
        {item('us', '/pricing/us', 'United States · $')}
      </div>
    </nav>
  );
}

/* ---- the page ---------------------------------------------------------------- */

export function PricingView({ market }: { market: Market }) {
  const m = MONEY[market];
  const us = market === 'us';
  return (
    <>
      {/* ---- hero ---------------------------------------------------------------- */}
      <section className="flex min-h-[calc(100svh-72px)] items-center overflow-x-clip py-10 lg:py-12">
        <div
          className={`${WRAP} grid grid-cols-[minmax(0,1fr)] items-center gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]`}
        >
          <div>
            <Eyebrow>{us ? 'Pricing · United States' : 'Pricing'}</Eyebrow>
            <h1 className="mt-6 text-[2.7rem] leading-[1.05] font-extrabold tracking-[-0.03em] text-ink sm:text-[3.6rem] lg:text-[3.2rem] xl:text-[3.8rem] 2xl:text-[4.4rem]">
              Simple pricing
              <br />
              for <span className="text-leaf">growing brands.</span>
            </h1>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-body xl:text-[19px]">
              {us
                ? 'Transparent, predictable and fair. Choose a plan that fits your store. You pay for results: calls where your customer gives a clear answer.'
                : 'Transparent, predictable and fair. Choose a plan that fits your store. You pay for results: clear answers on confirmation calls, connected minutes on the support line.'}
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
        <MarketSwitch market={market} />
        {us ? (
          <p className="mx-auto mt-6 max-w-2xl rounded-2xl border border-leaf/30 bg-sage-100 px-6 py-4 text-center text-[14.5px] leading-relaxed text-ink/80 xl:text-[15.5px]">
            <strong className="font-semibold text-ink">Early access.</strong> Calls to US customers
            open account by account after our launch checks. Prices below are what you will be
            billed, in US dollars.
          </p>
        ) : null}
        <div className="mt-8">
          <PlanPicker families={FAMILIES[market]} />
        </div>
      </section>

      {/* ---- promises ------------------------------------------------------------ */}
      <section className={`${WRAP} pb-16`}>
        <ul className={`${CARD} grid gap-6 px-7 py-7 sm:grid-cols-2 lg:grid-cols-4 lg:px-10`}>
          {PROMISES[market].map(({ Icon, title, body }) => (
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
                <GroupRow label={us ? 'Confirmation calls' : 'COD confirmation calls'} />
                <Row
                  label="Monthly fee"
                  cells={OUTBOUND.map((p) => m.money(m.price(p).feeMinor))}
                />
                <Row
                  label="Confirmed outcomes included"
                  cells={OUTBOUND.map((p) => m.count(m.price(p).includedUnits))}
                />
                <Row
                  label="After that, per outcome"
                  cells={OUTBOUND.map((p) => m.money(m.price(p).unitMinor))}
                />
                {us ? null : (
                  <>
                    <GroupRow label="Support line" />
                    <Row
                      label="Monthly fee"
                      cells={INBOUND.map((p) => m.money(m.price(p).feeMinor))}
                    />
                    <Row
                      label="Connected minutes included"
                      cells={INBOUND.map((p) => m.count(m.price(p).includedUnits))}
                    />
                    <Row
                      label="After that, per minute"
                      cells={INBOUND.map((p) => m.money(m.price(p).unitMinor))}
                    />
                  </>
                )}
                <GroupRow label="Every plan" />
                {EVERY_PLAN[market].map((feature) => (
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
            {FAQS[market].map(({ q, a }, index) => (
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
