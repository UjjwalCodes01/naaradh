'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { LINKS, NAV } from '@/lib/site-links';
import { ArrowRightIcon, CloseIcon, MenuIcon } from './icons';
import { Logo } from './ui';

/**
 * The site header. The only interactive piece on the marketing site: a menu that opens below
 * the bar on small screens. Everything else is a link, so the page works before hydration.
 */
export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-line-soft/70 bg-cream/85 backdrop-blur">
      <div className="mx-auto flex h-[72px] max-w-[1600px] items-center justify-between px-6 lg:px-10 xl:px-14">
        <Link
          href="/"
          aria-label="Naaradh home"
          onClick={() => {
            setOpen(false);
          }}
        >
          <Logo />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-8 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
              className={`relative py-1 text-[14px] font-medium transition-colors hover:text-ink ${
                pathname === item.href
                  ? 'text-ink after:absolute after:inset-x-0 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-leaf'
                  : 'text-body'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Link
            href={LINKS.signIn}
            className="rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-ink ring-1 ring-line transition-colors hover:bg-cream-200"
          >
            Log in
          </Link>
          <Link
            href={LINKS.shopifyInstall}
            className="inline-flex items-center gap-1.5 rounded-full bg-forest px-4 py-2 text-[13px] font-semibold text-cream transition-colors hover:bg-forest-700"
          >
            Install on Shopify
            <ArrowRightIcon className="h-3.5 w-3.5" />
          </Link>
        </div>

        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
          }}
          aria-expanded={open}
          aria-controls="site-menu"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink ring-1 ring-line md:hidden"
        >
          <span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
          {open ? <CloseIcon className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
        </button>
      </div>

      {open ? (
        <div id="site-menu" className="border-t border-line-soft bg-cream px-5 py-4 md:hidden">
          <nav aria-label="Main" className="flex flex-col gap-1">
            {NAV.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                onClick={() => {
                  setOpen(false);
                }}
                className="rounded-xl px-2 py-2.5 text-[15px] font-medium text-ink hover:bg-sage-100"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="mt-3 flex flex-col gap-2">
            <Link
              href={LINKS.shopifyInstall}
              onClick={() => {
                setOpen(false);
              }}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-forest px-5 py-3 text-sm font-semibold text-cream"
            >
              Install on Shopify
              <ArrowRightIcon className="h-4 w-4" />
            </Link>
            <Link
              href={LINKS.signIn}
              onClick={() => {
                setOpen(false);
              }}
              className="inline-flex items-center justify-center rounded-full bg-white px-5 py-3 text-sm font-semibold text-ink ring-1 ring-line"
            >
              Log in
            </Link>
          </div>
        </div>
      ) : null}
    </header>
  );
}
