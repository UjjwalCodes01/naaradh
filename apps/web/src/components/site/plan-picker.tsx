'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowRightIcon, CheckIcon } from './icons';

/**
 * The pricing page's plan cards. Naaradh bills its two products separately (ADR-0006, ADR-0008):
 * confirmation calls per confirmed outcome, the support line per connected minute. The toggle
 * switches between those two price books; there is no yearly billing to switch to.
 *
 * Every number arrives as a prop, formatted on the server from the plan catalogue, so this file
 * never holds a price of its own.
 */

export interface TierView {
  readonly code: string;
  readonly name: string;
  readonly tagline: string;
  readonly fee: string;
  readonly features: readonly string[];
  readonly cta: { readonly href: string; readonly label: string; readonly primary: boolean };
  readonly popular: boolean;
}

export interface FamilyView {
  readonly key: string;
  readonly label: string;
  readonly note: string;
  readonly tiers: readonly TierView[];
}

export function PlanPicker({ families }: { families: readonly FamilyView[] }) {
  const [active, setActive] = useState(families[0]?.key ?? '');
  const family = families.find((f) => f.key === active) ?? families[0];
  if (family === undefined) return null;

  return (
    <div>
      <div className="flex justify-center">
        <div
          role="tablist"
          aria-label="Product"
          className="inline-flex rounded-full border border-line bg-white/60 p-1.5"
        >
          {families.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={f.key === family.key}
              onClick={() => {
                setActive(f.key);
              }}
              className={`rounded-full px-6 py-2.5 text-[14.5px] font-semibold transition-colors xl:text-[15.5px] ${
                f.key === family.key ? 'bg-forest text-cream' : 'text-body hover:text-ink'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-4 text-center text-[14px] text-muted xl:text-[15px]">{family.note}</p>

      <div role="tabpanel" className="mt-10 grid gap-6 lg:grid-cols-3">
        {family.tiers.map((tier) => (
          <article
            key={tier.code}
            className={`relative flex flex-col rounded-[24px] border p-8 xl:p-9 ${
              tier.popular ? 'border-leaf/40 bg-sage-100' : 'border-line'
            }`}
          >
            <div className="flex h-8 items-center justify-between gap-3">
              <span
                className={`rounded-full px-3 py-1 text-[11.5px] font-bold tracking-[0.12em] text-forest uppercase ${
                  tier.popular ? 'bg-white/80' : 'bg-sage'
                }`}
              >
                {tier.name}
              </span>
              {tier.popular ? (
                <span className="rounded-lg bg-forest px-3 py-1.5 text-[12.5px] font-bold text-cream">
                  Most Popular
                </span>
              ) : null}
            </div>
            <p className="mt-7 text-[40px] leading-none font-extrabold tracking-tight text-ink xl:text-[46px]">
              {tier.fee}
              <span className="ml-1.5 text-[17px] font-medium tracking-normal text-muted">
                / month
              </span>
            </p>
            <p className="mt-3 text-[15px] text-body xl:text-[16px]">{tier.tagline}</p>

            <Link
              href={tier.cta.href}
              className={`mt-7 inline-flex w-full items-center justify-center gap-2 rounded-full px-6 py-3.5 text-[15px] font-semibold transition-colors ${
                tier.cta.primary
                  ? 'bg-forest text-cream hover:bg-forest-700'
                  : 'bg-white text-ink ring-1 ring-ink/15 hover:bg-cream-200'
              }`}
            >
              {tier.cta.label}
              <ArrowRightIcon className="h-4 w-4" />
            </Link>

            <ul className="mt-8 space-y-3.5">
              {tier.features.map((feature) => (
                <li key={feature} className="flex items-start gap-3">
                  <span className="mt-px inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-forest-500 text-white">
                    <CheckIcon className="h-3 w-3" />
                  </span>
                  <span className="text-[15px] leading-snug text-ink/80 xl:text-[16px]">
                    {feature}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </div>
  );
}
