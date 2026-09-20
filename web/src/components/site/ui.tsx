import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRightIcon, CheckIcon } from './icons';

/** Every marketing band shares one width and gutter. */
export const WRAP = 'mx-auto w-full max-w-[1600px] px-6 lg:px-10 xl:px-14';

/** An outlined card on the cream page. */
export const CARD = 'rounded-[24px] border border-line';

/** The wordmark: a leaf, then the name. Used in the header, the footer and the OG image. */
export function Logo({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
  return (
    <span
      className={`inline-flex items-center gap-2 text-[21px] font-extrabold tracking-tight ${
        tone === 'dark' ? 'text-forest' : 'text-cream'
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
        <path
          d="M12 21c0-5 1.8-8.4 5.4-10.2-.3 4.6-2.1 7.6-5.4 9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <path
          d="M19.5 3.6c.6 5.4-1 9-4.8 10.8-2.6 1.2-5.2.4-6-1.8-.8-2.3.6-4.8 3.4-6 2.3-1 4.8-1.7 7.4-3Z"
          fill="currentColor"
        />
      </svg>
      Naaradh
    </span>
  );
}

type ButtonProps = {
  readonly href: string;
  readonly children: ReactNode;
  readonly variant?: 'primary' | 'secondary' | 'onDark' | 'ghostOnDark';
  readonly size?: 'md' | 'lg';
  readonly arrow?: boolean;
  readonly className?: string;
};

const VARIANTS = {
  primary: 'bg-forest text-cream hover:bg-forest-700',
  secondary: 'bg-white text-ink ring-1 ring-ink/15 hover:bg-cream-200',
  onDark: 'bg-cream text-forest hover:bg-white',
  ghostOnDark: 'text-cream ring-1 ring-cream/45 hover:bg-white/10',
} as const;

const SIZES = {
  md: 'px-5 py-3 text-sm',
  lg: 'px-7 py-4 text-[15px] xl:text-[16px]',
} as const;

export function Button({
  href,
  children,
  variant = 'primary',
  size = 'md',
  arrow = false,
  className = '',
}: ButtonProps) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-leaf focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
    >
      {children}
      {arrow ? <ArrowRightIcon className="h-4 w-4" /> : null}
    </Link>
  );
}

/** The small capitalised label above every section heading. */
export function Eyebrow({
  children,
  tone = 'light',
}: {
  children: ReactNode;
  tone?: 'light' | 'sage';
}) {
  return (
    <span
      className={`inline-block rounded-full px-3.5 py-1.5 text-[11px] font-bold tracking-[0.14em] text-forest uppercase xl:text-[12px] ${
        tone === 'sage' ? 'bg-white/70' : 'bg-sage'
      }`}
    >
      {children}
    </span>
  );
}

/**
 * The left-hand column every section shares: eyebrow, heading, one line of copy, and optionally
 * a button and a handwritten aside.
 */
export function SectionIntro({
  eyebrow,
  title,
  body,
  children,
  tone = 'light',
}: {
  readonly eyebrow: string;
  readonly title: ReactNode;
  readonly body: string;
  readonly children?: ReactNode;
  readonly tone?: 'light' | 'sage';
}) {
  return (
    <div className="lg:max-w-lg">
      <Eyebrow tone={tone}>{eyebrow}</Eyebrow>
      <h2 className="mt-5 text-[2.1rem] leading-[1.1] font-extrabold tracking-tight text-ink sm:text-[2.7rem] xl:text-[3.1rem]">
        {title}
      </h2>
      <p className="mt-5 text-[16px] leading-relaxed text-body xl:text-[17.5px]">{body}</p>
      {children}
    </div>
  );
}

/** A filled green tick and a line of text — the bullet inside the product and plan cards. */
export function Tick({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-px inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-forest-500 text-white">
        <CheckIcon className="h-3.5 w-3.5" />
      </span>
      <span className="text-[15px] leading-snug text-body xl:text-[16px]">{children}</span>
    </li>
  );
}

const CHIP_SIZES = { md: 'h-12 w-12', lg: 'h-16 w-16', xl: 'h-20 w-20' } as const;

/** The mint circle behind a section icon. */
export function IconChip({
  children,
  size = 'md',
}: {
  children: ReactNode;
  size?: keyof typeof CHIP_SIZES;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-mint text-forest ${CHIP_SIZES[size]}`}
    >
      {children}
    </span>
  );
}

/** A handwritten margin note, as in the design. Decorative: hidden from screen readers. */
export function HandNote({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      aria-hidden
      className={`font-hand text-[21px] leading-snug text-forest-500/85 xl:text-[24px] ${className}`}
    >
      {children}
    </p>
  );
}

/** Wraps the pages that are not the homepage, which lay out their own sections full-bleed. */
export function SitePage({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-5xl px-5 py-12 sm:py-16">{children}</div>;
}
