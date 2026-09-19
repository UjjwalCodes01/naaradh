import type { Metadata } from 'next';
import Link from 'next/link';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { LINKS } from '@/lib/site-links';
import {
  ArrowDownIcon,
  BoxIcon,
  CheckIcon,
  EndCallIcon,
  GrowthIcon,
  HeadsetIcon,
  KeypadIcon,
  MicOffIcon,
  PlusIcon,
  RupeeIcon,
  ShieldIcon,
  SpeakerIcon,
  StarIcon,
  UserIcon,
} from '@/components/site/icons';
import { Button, CARD, Eyebrow, HandNote, IconChip, WRAP } from '@/components/site/ui';

export const metadata: Metadata = {
  title: 'Product',
  description:
    'Two products on one AI voice agent: a 24/7 support line for your store, and COD order confirmation calls before you ship.',
};

/**
 * naaradh.com/product. The two products in depth: hero, a product switcher, one panel per
 * product, why brands choose Naaradh, and the FAQ.
 *
 * Every claim here is one the product keeps today. Where the design's copy promised more than we
 * do (the agent "updating addresses", say), the text says what actually happens instead.
 */

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const SUPPORT_POINTS = [
  'Answers order status and delivery questions',
  'Answers return and policy questions from your help articles',
  'Shares order details only after verifying the caller',
  'Takes address changes and callbacks as tickets for your team',
  'Hands over to your team during working hours',
  'Natural conversations in Hindi, English or Hinglish',
] as const;

const COD_POINTS = [
  'Verifies order and delivery details',
  'Confirms the customer still wants the order',
  'Cancels unshipped COD orders on request, if you allow it',
  'Only calls between 9 a.m. and 9 p.m.',
  'Respects DND and consent rules',
  'Writes the outcome back to your store',
] as const;

const WHY: readonly { Icon: Icon; title: string; body: string }[] = [
  {
    Icon: ShieldIcon,
    title: 'Built for compliance',
    body: 'Follows Indian telecom rules: calling hours, DND, consent and disclosure.',
  },
  {
    Icon: RupeeIcon,
    title: 'Reduces operational cost',
    body: 'Fewer RTOs, a lighter support load and happier customers.',
  },
  {
    Icon: StarIcon,
    title: 'Simple to set up',
    body: 'Install the app, set your preferences, go live.',
  },
  {
    Icon: GrowthIcon,
    title: 'Pay for results',
    body: 'Confirmation calls are billed only when a customer gives a clear answer.',
  },
];

const FAQS = [
  {
    q: 'Can I use both products together?',
    a: 'Yes. Both run on the same agent, the same numbers and the same dashboard. The support line is billed per connected minute; confirmation calls are billed per confirmed outcome.',
  },
  {
    q: 'Which phone number will be used?',
    a: 'Your support line gets an Indian number: publish it, or forward your existing line to it. Confirmation calls also go out from Indian numbers, never from a foreign caller ID.',
  },
  {
    q: 'Does it work with my existing Shopify store?',
    a: 'Yes. Naaradh installs as a Shopify app and reads your orders from there. There is also a WooCommerce plugin and a REST API for other stores.',
  },
  {
    q: 'Is it compliant with Indian telecom regulations?',
    a: 'It is built around them: calls only between 9 a.m. and 9 p.m., DND checks, recorded consent for marketing calls, and every call opens by saying it is an AI and that it is recorded. Opt-outs are permanent.',
  },
  {
    q: 'Can I customize the voice and language?',
    a: 'You choose the language (Hindi, English or Hinglish), the store name the agent uses and the answers in your help articles. Custom voices are part of the Enterprise plan. The AI and recording disclosures cannot be switched off.',
  },
] as const;

/* ---- small pieces ------------------------------------------------------------ */

/** A filled green circle with a tick: the checklist bullet in both product panels. */
function Point({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-px inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-forest-500 text-white">
        <CheckIcon className="h-3 w-3" />
      </span>
      <span className="text-[15px] leading-snug text-ink/80 xl:text-[16px]">{children}</span>
    </li>
  );
}

const WAVE = [4, 8, 5, 12, 7, 16, 10, 20, 12, 7, 15, 9, 18, 11, 6, 13, 8, 5, 10, 4];

function Waveform({ className = '' }: { className?: string }) {
  return (
    <span aria-hidden className={`flex items-center gap-[3px] ${className}`}>
      {WAVE.map((h, i) => (
        <span key={i} className="w-[2.5px] rounded-full bg-current" style={{ height: h }} />
      ))}
    </span>
  );
}

function Avatar({ agent = false }: { agent?: boolean }) {
  return (
    <span
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
        agent ? 'bg-mint text-forest' : 'bg-cream-200 text-body'
      }`}
    >
      {agent ? <HeadsetIcon className="h-5 w-5" /> : <UserIcon className="h-5 w-5" />}
    </span>
  );
}

/** A speech bubble in the hero, attributed to a speaker. */
function Bubble({
  who,
  agent = false,
  children,
  className = '',
}: {
  who: string;
  agent?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`absolute z-10 rounded-2xl border border-line-soft bg-white p-4 shadow-[0_18px_40px_-20px_rgba(17,26,21,0.25)] ${className}`}
    >
      <p className="flex items-center gap-2 text-[13px] font-bold text-ink">
        <span
          className={`inline-flex h-6 w-6 items-center justify-center rounded-full ${
            agent ? 'bg-leaf text-white' : 'bg-cream-200 text-body'
          }`}
        >
          {agent ? <HeadsetIcon className="h-3.5 w-3.5" /> : <UserIcon className="h-3.5 w-3.5" />}
        </span>
        {who}
      </p>
      <p className="mt-2 text-[13px] leading-relaxed text-body">{children}</p>
    </div>
  );
}

/** The hero's phone on a live call, surrounded by what was said. Decorative. */
function CallScene() {
  return (
    <div
      className="relative mx-auto h-[270px] w-[342px] sm:h-[450px] sm:w-[560px] 2xl:h-[540px] 2xl:w-[672px]"
      aria-hidden
    >
      <div className="absolute top-0 left-0 h-[450px] w-[560px] origin-top-left scale-[0.61] sm:scale-100 2xl:scale-[1.2]">
        {/* the phone */}
        <div className="absolute top-0 left-1/2 flex h-[440px] w-[232px] -translate-x-1/2 flex-col items-center rounded-[40px] border-[7px] border-[#1b211e] bg-[#0f1311] px-5 pt-4 pb-6 text-white shadow-[0_40px_80px_-30px_rgba(17,26,21,0.55)]">
          <div className="flex w-full items-center justify-between text-[10px] text-white/60">
            <span>9:41</span>
            <span className="h-4 w-16 rounded-full bg-black" />
            <span>5G</span>
          </div>
          <span className="mt-9 inline-flex h-16 w-16 items-center justify-center rounded-full bg-white text-forest">
            <HeadsetIcon className="h-8 w-8" />
          </span>
          <p className="mt-4 text-[17px] font-semibold">Naaradh AI</p>
          <p className="mt-1 text-[11px] text-white/55">00:24</p>
          <Waveform className="mt-7 text-mint" />
          <div className="mt-auto grid w-full grid-cols-3 gap-2 text-center text-[9.5px] text-white/60">
            {[
              { I: MicOffIcon, l: 'Mute' },
              { I: KeypadIcon, l: 'Keypad' },
              { I: SpeakerIcon, l: 'Speaker' },
            ].map(({ I, l }) => (
              <span key={l} className="flex flex-col items-center gap-1.5">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10">
                  <I className="h-4.5 w-4.5 text-white" />
                </span>
                {l}
              </span>
            ))}
          </div>
          <span className="mt-5 inline-flex h-12 w-12 items-center justify-center rounded-full bg-[#e5484d]">
            <EndCallIcon className="h-6 w-6 text-white" />
          </span>
        </div>

        <Bubble who="Customer" className="top-[48px] left-0 w-[190px]">
          “मेरा ऑर्डर कहाँ है?”
        </Bubble>
        <Bubble who="Naaradh AI" agent className="top-[160px] left-0 w-[222px]">
          “नमस्ते! मैं StyleKart की AI असिस्टेंट हूँ, यह कॉल रिकॉर्ड हो रही है। एक पल, आपका ऑर्डर
          देखा जा रहा है…”
        </Bubble>
        <Bubble who="Customer" className="top-[48px] right-0 w-[170px]">
          “Can I change the address?”
        </Bubble>

        <div className="absolute top-[250px] right-0 flex flex-col items-end">
          <svg viewBox="0 0 70 60" className="mr-16 h-14 w-16 text-forest-500/60">
            <path
              d="M6 56C30 50 50 34 58 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path
              d="m50 12 8-6 4 9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <HandNote className="-rotate-6 text-right">
            Real conversations.
            <br />
            Real customers.
            <br />
            Real impact.
          </HandNote>
        </div>
      </div>
    </div>
  );
}

/** One product, one panel: intro, what it does, and what it sounds like. */
function ProductPanel({
  id,
  label,
  title,
  tagline,
  body,
  points,
  tone,
  visual,
}: {
  id: string;
  label: string;
  title: ReactNode;
  tagline: string;
  body: string;
  points: readonly string[];
  tone: 'sage' | 'peach';
  visual: ReactNode;
}) {
  return (
    <section id={id} className={`${WRAP} scroll-mt-24 py-4`}>
      <div
        className={`grid items-center gap-10 rounded-[32px] px-7 py-12 sm:px-12 lg:grid-cols-[1fr_1fr_1.05fr] lg:gap-10 lg:px-14 lg:py-14 ${
          tone === 'sage' ? 'bg-sage-100' : 'bg-peach'
        }`}
      >
        <div>
          <Eyebrow>{label}</Eyebrow>
          <h2 className="mt-5 text-[2.1rem] leading-[1.08] font-extrabold tracking-tight text-ink sm:text-[2.6rem] xl:text-[3rem]">
            {title}
          </h2>
          <p className="mt-3 text-[17px] font-medium text-ink/75 xl:text-[19px]">{tagline}</p>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-body xl:text-[16px]">
            {body}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-6">
            <Button href={LINKS.shopifyInstall} size="lg" arrow>
              Install on Shopify
            </Button>
            <Link
              href="#why-naaradh"
              className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-ink hover:text-forest"
            >
              Explore features
              <ArrowDownIcon className="h-4 w-4" />
            </Link>
          </div>
        </div>

        <ul className="space-y-4">
          {points.map((point) => (
            <Point key={point}>{point}</Point>
          ))}
        </ul>

        <div>{visual}</div>
      </div>
    </section>
  );
}

/** Product 1's visual: a short, verified support conversation. */
function SupportChat() {
  const lines: readonly { agent: boolean; text: string }[] = [
    { agent: false, text: 'Hi, where is my order?' },
    {
      agent: true,
      text: 'Happy to check. Could you tell me your order number and delivery pincode?',
    },
    { agent: false, text: 'It’s #SK1234, 110001.' },
  ];
  return (
    <div aria-hidden>
      <div className="space-y-4 rounded-[24px] border border-line-soft bg-white p-6 shadow-[0_18px_40px_-24px_rgba(17,26,21,0.2)]">
        {lines.map(({ agent, text }) => (
          <div key={text} className={`flex items-start gap-3 ${agent ? 'pl-6' : ''}`}>
            <Avatar agent={agent} />
            <p
              className={`rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed ${
                agent ? 'bg-sage-100 text-ink' : 'bg-cream text-ink'
              }`}
            >
              {text}
            </p>
          </div>
        ))}
      </div>
      <HandNote className="mt-4 -rotate-3 text-right">Answers in your brand’s voice.</HandNote>
    </div>
  );
}

/** Product 2's visual: the agent mid-way through a confirmation call. */
function ConfirmCall() {
  return (
    <div aria-hidden className="flex flex-col items-start gap-4 sm:flex-row">
      <div className="flex w-[190px] shrink-0 flex-col items-center rounded-[24px] border border-line-soft bg-white px-5 py-8 text-center shadow-[0_18px_40px_-24px_rgba(17,26,21,0.2)]">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-forest text-cream">
          <HeadsetIcon className="h-6 w-6" />
        </span>
        <p className="mt-4 text-[15px] font-bold text-ink">Naaradh AI</p>
        <p className="mt-1 text-[12px] text-muted">Calling customer…</p>
        <Waveform className="mt-6 text-leaf" />
      </div>
      <div className="sm:pt-4">
        <p className="rounded-2xl border border-line-soft bg-white p-4 text-[14px] leading-relaxed text-ink shadow-[0_18px_40px_-24px_rgba(17,26,21,0.2)]">
          नमस्ते! यह StyleKart की ओर से एक AI कॉल है, जो रिकॉर्ड हो रही है। आपका ऑर्डर कन्फ़र्म करने
          के लिए कॉल किया है।
        </p>
        <HandNote className="mt-6 -rotate-6 text-right">
          Fewer RTOs.
          <br />
          More delivered orders.
        </HandNote>
      </div>
    </div>
  );
}

/* ---- the page ---------------------------------------------------------------- */

export default function ProductPage() {
  return (
    <>
      {/* ---- hero ---------------------------------------------------------------- */}
      <section className="flex min-h-[calc(100svh-72px)] items-center overflow-x-clip py-10 lg:py-12">
        <div className={`${WRAP} grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]`}>
          <div>
            <Eyebrow>Products</Eyebrow>
            <h1 className="mt-6 text-[2.5rem] leading-[1.06] font-extrabold tracking-[-0.03em] text-ink sm:text-[3.1rem] lg:text-[2.9rem] xl:text-[3.2rem] 2xl:text-[3.6rem]">
              Two products.
              <br />
              One reliable <span className="text-leaf">AI voice agent.</span>
            </h1>
            <p className="mt-7 max-w-xl text-[16px] leading-relaxed text-body xl:text-[18px] 2xl:max-w-2xl 2xl:text-[19px]">
              Naaradh handles the phone, so you can focus on growing your brand. Choose one product
              or use both — built for Indian ecommerce, with compliance at the core.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Button href={LINKS.shopifyInstall} size="lg" arrow>
                Install on Shopify
              </Button>
              <Button href={LINKS.talkToUs} size="lg" variant="secondary">
                Book a demo
              </Button>
            </div>
          </div>
          <CallScene />
        </div>
      </section>

      {/* ---- product switcher ---------------------------------------------------- */}
      <section className={`${WRAP} pb-8`}>
        <div className="grid gap-4 md:grid-cols-[1fr_1fr_1.1fr]">
          <Link
            href="#support-line"
            className="flex items-center gap-4 rounded-[20px] border border-leaf/30 bg-sage-100 px-6 py-5 transition-colors hover:border-leaf/60"
          >
            <IconChip>
              <HeadsetIcon className="h-6 w-6" />
            </IconChip>
            <span>
              <span className="block text-[16px] font-bold text-ink xl:text-[17px]">
                AI Customer Support Line
              </span>
              <span className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-mint px-2.5 py-0.5 text-[12px] font-semibold text-forest">
                24/7
                <span className="h-1.5 w-1.5 rounded-full bg-leaf" />
              </span>
            </span>
          </Link>
          <Link
            href="#cod-confirmation"
            className={`${CARD} flex items-center gap-4 px-6 py-5 transition-colors hover:border-leaf/40`}
          >
            <span className="inline-flex h-12 w-12 items-center justify-center text-ink">
              <BoxIcon className="h-8 w-8" />
            </span>
            <span>
              <span className="block text-[16px] font-bold text-ink xl:text-[17px]">
                COD Order Confirmation
              </span>
              <span className="mt-1 inline-block rounded-full bg-cream-200 px-2.5 py-0.5 text-[12px] font-semibold text-body">
                Pre-shipment
              </span>
            </span>
          </Link>
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-[20px] bg-sage-100/60 px-6 py-5">
            <p className="text-[14.5px] leading-snug text-body">
              <span className="font-semibold text-ink">Not sure which one you need?</span>
              <br />
              Talk to our team and we’ll help you choose.
            </p>
            <Button href={LINKS.talkToUs} variant="secondary" arrow>
              Talk to us
            </Button>
          </div>
        </div>
      </section>

      {/* ---- the two products ---------------------------------------------------- */}
      <ProductPanel
        id="support-line"
        label="Product 1"
        title={
          <>
            AI Customer
            <br className="hidden sm:block" /> Support Line
          </>
        }
        tagline="Your always-on support agent."
        body="Naaradh answers your store’s phone line 24/7, handles common customer questions, and passes the rest to your team with a ticket or a live handover."
        points={SUPPORT_POINTS}
        tone="sage"
        visual={<SupportChat />}
      />

      <ProductPanel
        id="cod-confirmation"
        label="Product 2"
        title={
          <>
            COD Order
            <br className="hidden sm:block" /> Confirmation
          </>
        }
        tagline="Stop RTOs before they happen."
        body="Naaradh calls your customers within minutes of a cash-on-delivery order to confirm the details, cutting return-to-origin losses and wasted shipping."
        points={COD_POINTS}
        tone="peach"
        visual={<ConfirmCall />}
      />

      {/* ---- why ----------------------------------------------------------------- */}
      <section id="why-naaradh" className={`${WRAP} scroll-mt-24 pt-16 pb-10 sm:pt-20`}>
        <h2 className="text-[1.9rem] leading-tight font-extrabold tracking-tight text-ink sm:text-[2.3rem] xl:text-[2.6rem]">
          Why online brands choose Naaradh
        </h2>
        <div className="mt-9 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {WHY.map(({ Icon, title, body }) => (
            <article key={title} className={`${CARD} p-7`}>
              <IconChip size="lg">
                <Icon className="h-7 w-7" />
              </IconChip>
              <h3 className="mt-6 text-[18px] font-bold text-ink xl:text-[19px]">{title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-body">{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ---- faq ----------------------------------------------------------------- */}
      <section className={`${WRAP} py-16 sm:py-24`}>
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,9fr)] lg:gap-16">
          <div className="lg:max-w-lg">
            <Eyebrow>FAQ</Eyebrow>
            <h2 className="mt-5 text-[2.1rem] leading-[1.1] font-extrabold tracking-tight text-ink sm:text-[2.7rem] xl:text-[3.1rem]">
              Common questions
              <br className="hidden sm:block" /> about our products.
            </h2>
            <p className="mt-5 text-[16px] leading-relaxed text-body xl:text-[17.5px]">
              Everything you need to know about how Naaradh works.
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
