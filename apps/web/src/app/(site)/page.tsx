import Image from 'next/image';
import { PLANS, type Plan } from '@naaradh/pipeline';
import { rupees } from '@/lib/money';
import { LINKS } from '@/lib/site-links';
import {
  ArrowRightIcon,
  BoxIcon,
  CalendarIcon,
  CartIcon,
  ChatIcon,
  CheckIcon,
  ClockIcon,
  DocIcon,
  DotsIcon,
  GridIcon,
  HeadsetIcon,
  IndiaIcon,
  LockIcon,
  PhoneCallIcon,
  PhoneIcon,
  PlusIcon,
  ShieldIcon,
  ShopBagIcon,
  SlidersIcon,
  SmileIcon,
  UserStopIcon,
  WaveIcon,
} from '@/components/site/icons';
import { Button, CARD, HandNote, IconChip, SectionIntro, Tick, WRAP } from '@/components/site/ui';

/**
 * naaradh.com home. Nine bands, mobile first: a full-screen hero, proof strip, the two products,
 * how it works, compliance, integrations, pricing and the FAQ.
 *
 * Prices are read from the same plan catalogue the ledger bills from (ADR-0008), so the page
 * cannot quietly disagree with what a merchant is charged.
 */

/** Every band uses one intro-left / content-right split. */
const SPLIT = 'grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,9fr)] lg:gap-16';

const STATS = [
  { Icon: HeadsetIcon, value: '24/7', label: 'Customer support' },
  { Icon: BoxIcon, value: 'Fewer', label: 'COD returns' },
  { Icon: SmileIcon, value: 'Happier', label: 'customers' },
  { Icon: IndiaIcon, value: 'Built for', label: 'Indian businesses' },
] as const;

const PRODUCTS = [
  {
    Icon: PhoneCallIcon,
    title: 'AI Customer Support Line',
    body: 'Answers your store’s phone line 24/7. Handles order tracking, returns and policy questions, and takes address changes as tickets. Passes to your team when needed.',
    points: [
      'Natural, human-like conversations',
      'Answers common questions',
      'Raises a ticket if needed',
      'Hands over to your team during working hours',
    ],
  },
  {
    Icon: BoxIcon,
    title: 'COD Order Confirmation',
    body: 'Calls your customers before shipping to confirm cash-on-delivery orders. Helps you reduce RTOs and save on shipping costs.',
    points: [
      'Verifies order & delivery details',
      'Cancels unshipped COD orders on request, if you allow it',
      'Only calls within allowed hours',
      'Respects DND and consent rules',
    ],
  },
] as const;

/**
 * The other things the same agent already does (ADR-0010 abandoned-cart ingestion, promotional
 * calling, and the appointments vertical). Kept honest: only use cases that ship today.
 */
const USE_CASES = [
  {
    Icon: CartIcon,
    title: 'Cart recovery calls',
    body: 'Re-engage interested customers (with consent).',
  },
  {
    Icon: ChatIcon,
    title: 'Post-delivery feedback',
    body: 'Hear how it went after delivery (with consent).',
  },
  {
    Icon: CalendarIcon,
    title: 'Appointment reminders',
    body: 'Reduce no-shows and save time.',
  },
  {
    Icon: GridIcon,
    title: 'Works across categories',
    body: 'Fashion, beauty, home and more.',
  },
] as const;

const STEPS = [
  {
    Icon: ShopBagIcon,
    number: '01',
    title: 'Connect your store',
    body: 'Install the app on Shopify or WooCommerce.',
  },
  {
    Icon: SlidersIcon,
    number: '02',
    title: 'Set your preferences',
    body: 'Choose what it should handle and how it should talk.',
  },
  {
    Icon: PhoneIcon,
    number: '03',
    title: 'Start receiving calls',
    body: 'Naaradh goes live and starts talking to your customers.',
  },
] as const;

/** Two columns in the design, read top to bottom. */
const COMPLIANCE = [
  [
    { Icon: ClockIcon, label: 'Calls only 9 a.m. – 9 p.m.' },
    { Icon: ShieldIcon, label: 'Checks DND registry' },
    { Icon: DocIcon, label: 'Marketing calls only with recorded consent' },
  ],
  [
    { Icon: WaveIcon, label: 'Clearly announces it’s an AI' },
    { Icon: LockIcon, label: 'Informs that the call is recorded' },
    { Icon: UserStopIcon, label: 'Stops calling when asked' },
  ],
] as const;

const FAQS = [
  {
    q: 'What is Naaradh?',
    a: 'An AI voice agent for online shops. It answers your store’s phone line around the clock, and calls customers to confirm cash-on-delivery orders before you ship them. It speaks Hindi, English and a mix of both.',
  },
  {
    q: 'Is my customer data safe?',
    a: 'Phone numbers are stored encrypted, and we look customers up by a one-way hash, so numbers never appear in our logs or exports. Every merchant’s data is isolated at the database level, and every time a recording or transcript is opened it is written to an access log you can read.',
  },
  {
    q: 'Do you call without consent?',
    a: 'Never for marketing. Cart-recovery and feedback calls go only to people who gave recorded consent, and the exact wording they agreed to is stored with it. Order confirmations are calls about an order the customer just placed with you. Anyone who says no on a call is not called for that reason again for at least 90 days, and a number registered on our do-not-call page is never called again.',
  },
  {
    q: 'What languages are supported?',
    a: 'Hindi, Indian English and the mix of the two most customers actually speak. The agent announces that it is an AI and that the call is recorded in whichever language it opens in.',
  },
  {
    q: 'How does pricing work?',
    a: 'Outbound calls are billed only when a person answered and gave a definitive answer — confirmed, confirmed with changes, cancelled, rescheduled or booked. No answer, voicemail, a wrong number or an unclear call is never billed. The support line is billed per connected minute. You set a monthly spending cap and calls pause at it.',
  },
] as const;

/** ₹1,999 rather than ₹1999.00 when the fee is a whole number of rupees. */
function monthlyFee(plan: Plan | undefined): string {
  return rupees(plan?.prices.INR.feeMinor ?? 0);
}

function planLine(plan: Plan | undefined): string {
  return plan === undefined
    ? ''
    : `${plan.prices.INR.includedUnits.toLocaleString('en-IN')} ${plan.unit === 'outcome' ? 'confirmed outcomes' : 'minutes'} / month`;
}

function Pill({ children }: { children: string }) {
  return (
    <span className="inline-block rounded-full bg-sage px-3.5 py-1.5 text-[11px] font-bold tracking-[0.14em] text-forest uppercase xl:text-[12px]">
      {children}
    </span>
  );
}

export default function Home() {
  const starter = PLANS['starter'];
  const growth = PLANS['growth'];

  return (
    <>
      {/* ---- hero: the whole first screen ---------------------------------------- */}
      <section className="flex min-h-[calc(100svh-72px)] items-center overflow-x-clip py-10 lg:py-12">
        <div
          className={`${WRAP} grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)] lg:gap-10`}
        >
          <div>
            <Pill>AI voice agent for Indian online shops</Pill>
            <h1 className="mt-7 text-[2.7rem] leading-[1.02] font-extrabold tracking-[-0.035em] text-ink sm:text-[3.6rem] lg:text-[3.5rem] xl:text-[4.4rem] 2xl:text-[5.4rem]">
              Your customers <br className="hidden lg:block" />
              call. <span className="text-leaf">Naaradh</span> <br className="hidden lg:block" />
              handles it.
            </h1>
            <p className="mt-7 max-w-xl text-[16px] leading-relaxed text-body xl:text-[18px] 2xl:max-w-2xl 2xl:text-[19px]">
              Answer customer calls 24/7, confirm COD orders, reduce returns, and give every shopper
              a better experience — in Hindi, English or Hinglish.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Button href={LINKS.shopifyInstall} size="lg" arrow>
                Install on Shopify
              </Button>
              <Button href={LINKS.talkToUs} size="lg" variant="secondary">
                Talk to us
              </Button>
            </div>
            <ul className="mt-8 space-y-2.5">
              {['Works with Shopify & WooCommerce', 'Quick setup • No coding required'].map(
                (line) => (
                  <li
                    key={line}
                    className="flex items-center gap-2.5 text-[14.5px] text-body xl:text-[15.5px]"
                  >
                    <CheckIcon className="h-4 w-4 text-leaf" />
                    {line}
                  </li>
                ),
              )}
            </ul>
          </div>

          <div className="relative">
            <Image
              src="/hero-call.png"
              alt="A customer on the phone with Naaradh, which is confirming her order before it ships."
              width={1345}
              height={884}
              priority
              sizes="(max-width: 1024px) 100vw, 70vw"
              className="h-auto w-full max-w-none xl:-ml-[7%] xl:w-[122%] min-[1800px]:-ml-[12%] min-[1800px]:w-[130%]"
            />
          </div>
        </div>
      </section>

      {/* ---- proof strip --------------------------------------------------------- */}
      <section className={`${WRAP} pb-6`}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-10 py-6 lg:flex lg:justify-between lg:py-10">
          {STATS.map(({ Icon, value, label }) => (
            <div
              key={label}
              className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-5"
            >
              <IconChip size="xl">
                <Icon className="h-9 w-9" />
              </IconChip>
              <p className="text-[21px] leading-tight font-bold text-ink xl:text-[26px]">
                {value}
                <span className="mt-1.5 block text-[15px] font-medium text-body xl:text-[17px]">
                  {label}
                </span>
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- two products -------------------------------------------------------- */}
      <section id="products" className={`${WRAP} scroll-mt-24 py-16 sm:py-24`}>
        <div className={`${SPLIT} items-center`}>
          <SectionIntro
            eyebrow="Two powerful products"
            title={
              <>
                Built for real
                <br className="hidden sm:block" /> ecommerce needs.
              </>
            }
            body="Naaradh handles the phone, so you can focus on growing your brand."
          >
            <div className="mt-10 hidden items-end gap-4 pl-10 lg:flex">
              <svg viewBox="0 0 70 90" className="h-24 w-16 text-forest-500/60" aria-hidden>
                <path
                  d="M20 4C4 30 8 70 62 80"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <path
                  d="m12 10 8-6 5 9M54 73l8 7-9 5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <HandNote className="-rotate-3 pb-1">
                Two use cases.
                <br />
                One reliable AI voice agent.
              </HandNote>
            </div>
          </SectionIntro>

          <div className="grid gap-6 md:grid-cols-2">
            {PRODUCTS.map(({ Icon, title, body, points }) => (
              <article key={title} className={`${CARD} p-7 sm:p-9`}>
                <IconChip size="lg">
                  <Icon className="h-7 w-7" />
                </IconChip>
                <h3 className="mt-7 text-[21px] leading-snug font-bold text-ink xl:text-[24px]">
                  {title}
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-body xl:text-[16.5px]">
                  {body}
                </p>
                <ul className="mt-7 space-y-3.5">
                  {points.map((point) => (
                    <Tick key={point}>{point}</Tick>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ---- more use cases -------------------------------------------------------- */}
      <section className={`${WRAP} pb-10 sm:pb-14`}>
        <div className={`${SPLIT} items-center`}>
          <SectionIntro
            eyebrow="Use cases"
            title={
              <>
                More than just
                <br className="hidden sm:block" /> order confirmations.
              </>
            }
            body="With their consent, Naaradh can also call customers who left a cart behind or ask for feedback after delivery. It can remind people about appointments too."
          >
            <div className="mt-9">
              <Button href={LINKS.useCases} size="lg" variant="secondary" arrow>
                See all use cases
              </Button>
            </div>
          </SectionIntro>

          <div className="grid gap-5 sm:grid-cols-2">
            {USE_CASES.map(({ Icon, title, body }) => (
              <article key={title} className={`${CARD} flex items-start gap-4 p-6`}>
                <IconChip>
                  <Icon className="h-6 w-6" />
                </IconChip>
                <div>
                  <h3 className="text-[15.5px] font-bold text-ink xl:text-[16.5px]">{title}</h3>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-body xl:text-[14.5px]">
                    {body}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ---- how it works -------------------------------------------------------- */}
      <section className={`${WRAP} pb-10 sm:pb-14`}>
        <div className={`${SPLIT} items-center`}>
          <SectionIntro
            eyebrow="How it works"
            title={
              <>
                Get started in
                <br className="hidden sm:block" /> 3 simple steps.
              </>
            }
            body="Set up Naaradh in minutes. No complex configuration, no coding required."
          />

          <ol className="grid gap-5 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center md:gap-4">
            {STEPS.map(({ Icon, number, title, body }, index) => (
              <li key={number} className="contents">
                <div className={`${CARD} h-full px-5 py-7 text-center`}>
                  <p className="text-left text-[18px] font-extrabold text-forest-500 xl:text-[20px]">
                    {number}
                  </p>
                  <div className="mt-1 flex justify-center">
                    <IconChip size="xl">
                      <Icon className="h-9 w-9" />
                    </IconChip>
                  </div>
                  <h3 className="mt-6 text-[17px] font-bold text-ink xl:text-[18.5px]">{title}</h3>
                  <p className="mt-2.5 text-[14.5px] leading-relaxed text-body xl:text-[15.5px]">
                    {body}
                  </p>
                </div>
                {index < STEPS.length - 1 ? (
                  <ArrowRightIcon className="hidden h-6 w-6 text-forest-500 md:block" aria-hidden />
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---- compliance ---------------------------------------------------------- */}
      <section className={`${WRAP} py-6`}>
        <div
          className={`grid items-center gap-10 lg:grid-cols-[minmax(0,6fr)_minmax(0,8fr)] lg:gap-14 rounded-[32px] bg-sage px-7 py-12 sm:px-12 lg:px-16 lg:py-16`}
        >
          <SectionIntro
            eyebrow="Built for compliance"
            tone="sage"
            title={
              <>
                Responsible calling.
                <br className="hidden sm:block" /> By design.
              </>
            }
            body="Naaradh is built around Indian telecom rules and industry best practice: calling hours, DND, consent and disclosure are checked on every call."
          >
            <div className="mt-9">
              <Button href={LINKS.compliance} size="lg" variant="secondary" arrow>
                Our Compliance Approach
              </Button>
            </div>
          </SectionIntro>

          <div>
            <div className="grid rounded-[24px] bg-white p-7 sm:grid-cols-2 sm:p-9">
              {COMPLIANCE.map((column, c) => (
                <ul
                  key={c}
                  className={`space-y-6 ${
                    c === 0 ? 'sm:border-r sm:border-line-soft sm:pr-8' : 'mt-6 sm:mt-0 sm:pl-8'
                  }`}
                >
                  {column.map(({ Icon, label }) => (
                    <li key={label} className="flex items-center gap-4">
                      <IconChip>
                        <Icon className="h-6 w-6" />
                      </IconChip>
                      <span className="text-[15px] leading-snug text-ink/80 xl:text-[16.5px]">
                        {label}
                      </span>
                    </li>
                  ))}
                </ul>
              ))}
            </div>
            <div className="mt-6 hidden items-center justify-center gap-3 lg:flex">
              <HandNote className="-rotate-2 text-center">
                Your customers’ trust
                <br />
                is always protected.
              </HandNote>
              <svg viewBox="0 0 60 40" className="h-10 w-16 text-forest-500/60" aria-hidden>
                <path
                  d="M2 30C20 34 40 28 54 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <path
                  d="m45 8 9-2 1 9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          </div>
        </div>
      </section>

      {/* ---- integrations -------------------------------------------------------- */}
      <section id="integrations" className={`${WRAP} scroll-mt-24 py-16 sm:py-24`}>
        <div className={`${SPLIT} items-center`}>
          <SectionIntro
            eyebrow="Works with your tools"
            title={
              <>
                Integrates easily
                <br className="hidden sm:block" /> with your stack.
              </>
            }
            body="Get started quickly with the platforms you already use."
          />

          <ul className="grid gap-5 sm:grid-cols-3">
            <li className={`${CARD} flex h-32 items-center justify-center gap-2.5 px-6 xl:h-40`}>
              <ShopBagIcon className="h-11 w-11 text-[#5E8E3E]" />
              <span className="text-[30px] font-extrabold tracking-tight text-ink italic xl:text-[34px]">
                shopify
              </span>
            </li>
            <li className={`${CARD} flex h-32 items-center justify-center gap-1.5 px-6 xl:h-40`}>
              <span className="rounded-lg bg-[#7F54B3] px-2 py-0.5 text-[24px] font-extrabold tracking-tight text-white xl:text-[28px]">
                Woo
              </span>
              <span className="text-[22px] font-extrabold tracking-tight text-ink uppercase xl:text-[25px]">
                commerce
              </span>
            </li>
            <li className={`${CARD} flex h-32 items-center justify-center gap-4 px-6 xl:h-40`}>
              <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-cream-200">
                <DotsIcon className="h-6 w-6 text-body" />
              </span>
              <span className="text-[15px] leading-snug font-medium text-body xl:text-[16px]">
                More integrations
                <br />
                coming soon
              </span>
            </li>
          </ul>
        </div>
      </section>

      {/* ---- pricing ------------------------------------------------------------- */}
      <section className={`${WRAP} pb-16 sm:pb-24`}>
        <div className={`${SPLIT} items-center`}>
          <SectionIntro
            eyebrow="Simple, transparent pricing"
            title={
              <>
                Plans that scale
                <br className="hidden sm:block" /> with your business.
              </>
            }
            body={`Clear pricing. No hidden fees. Confirmation calls below; the 24/7 support line is priced separately, from ${monthlyFee(PLANS['inbound_starter'])} a month.`}
          >
            <div className="mt-9">
              <Button href={LINKS.pricing} size="lg" variant="secondary" arrow>
                See Pricing
              </Button>
            </div>
          </SectionIntro>

          <div className="grid gap-6 md:grid-cols-2">
            <article className={`${CARD} flex flex-col p-8 sm:p-9`}>
              <h3 className="text-[20px] font-bold text-ink xl:text-[22px]">Starter</h3>
              <p className="mt-1.5 text-[14.5px] text-muted xl:text-[15.5px]">
                For small stores getting started.
              </p>
              <p className="mt-7 text-[36px] font-extrabold tracking-tight text-ink xl:text-[42px]">
                {monthlyFee(starter)}
                <span className="text-[16px] font-medium tracking-normal text-muted"> / month</span>
              </p>
              <ul className="mt-7 mb-9 space-y-3.5">
                <Tick>COD order confirmation calls</Tick>
                <Tick>{planLine(starter)}</Tick>
                <Tick>Billed only on a clear answer</Tick>
              </ul>
              <Button
                href={LINKS.shopifyInstall}
                size="lg"
                variant="secondary"
                arrow
                className="mt-auto w-full"
              >
                Get Started
              </Button>
            </article>

            <article className={`${CARD} relative flex flex-col p-8 sm:p-9`}>
              <span className="absolute top-8 right-8 rounded-lg bg-forest px-3.5 py-1.5 text-[12.5px] font-bold text-cream">
                Most Popular
              </span>
              <h3 className="text-[20px] font-bold text-ink xl:text-[22px]">Growth</h3>
              <p className="mt-1.5 text-[14.5px] text-muted xl:text-[15.5px]">
                For growing brands.
              </p>
              <p className="mt-7 text-[36px] font-extrabold tracking-tight text-ink xl:text-[42px]">
                {monthlyFee(growth)}
                <span className="text-[16px] font-medium tracking-normal text-muted"> / month</span>
              </p>
              <ul className="mt-7 mb-9 space-y-3.5">
                <Tick>Everything in Starter</Tick>
                <Tick>{planLine(growth)}</Tick>
                <Tick>Priority support</Tick>
              </ul>
              <Button href={LINKS.shopifyInstall} size="lg" arrow className="mt-auto w-full">
                Get Started
              </Button>
            </article>
          </div>
        </div>
      </section>

      {/* ---- faq ----------------------------------------------------------------- */}
      <section id="faq" className={`${WRAP} scroll-mt-24 py-16 sm:py-24`}>
        <div className={`${SPLIT} items-start`}>
          <SectionIntro
            eyebrow="FAQ"
            title={
              <>
                Your questions,
                <br className="hidden sm:block" /> answered.
              </>
            }
            body="Simple answers to common questions."
          >
            <div className="mt-9">
              <Button href={LINKS.allFaqs} size="lg" variant="secondary" arrow>
                View all FAQs
              </Button>
            </div>
          </SectionIntro>

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
