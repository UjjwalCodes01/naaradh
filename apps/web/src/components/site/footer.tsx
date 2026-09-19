import Link from 'next/link';
import { LINKS } from '@/lib/site-links';
import { ArrowRightIcon, LinkedInIcon, XIcon, YouTubeIcon } from './icons';
import { Logo } from './ui';

const COLUMNS = [
  {
    heading: 'Product',
    links: [
      { href: '/#products', label: 'Features' },
      { href: LINKS.pricing, label: 'Pricing' },
      { href: '/#integrations', label: 'Shopify App' },
      { href: '/#integrations', label: 'WooCommerce' },
    ],
    muted: 'API (Coming Soon)',
  },
  {
    heading: 'Company',
    links: [
      { href: LINKS.about, label: 'About Us' },
      { href: LINKS.blog, label: 'Blog' },
      { href: LINKS.careers, label: 'Careers' },
      { href: '/contact', label: 'Contact' },
    ],
  },
  {
    heading: 'Resources',
    links: [
      { href: LINKS.helpCentre, label: 'Help Center' },
      { href: LINKS.compliance, label: 'Compliance' },
      { href: '/privacy', label: 'Privacy Policy' },
      { href: '/terms', label: 'Terms of Service' },
      { href: '/dpa', label: 'DPA' },
    ],
  },
] as const;

/**
 * The legal small print. `do-not-call` and the grievance officer are on every page because
 * India's telecom rules require them to be reachable without an account (SPEC §13).
 */
const SMALL_PRINT = [
  { href: LINKS.doNotCall, label: 'Do not call' },
  { href: '/grievance', label: 'Grievance officer' },
  { href: '/aup', label: 'Acceptable use' },
  { href: '/subprocessors', label: 'Sub-processors' },
  { href: '/cookies', label: 'Cookies' },
  { href: '/refunds', label: 'Refunds' },
] as const;

const SOCIALS = [
  { href: LINKS.social.linkedin, label: 'Naaradh on LinkedIn', Icon: LinkedInIcon },
  { href: LINKS.social.x, label: 'Naaradh on X', Icon: XIcon },
  { href: LINKS.social.youtube, label: 'Naaradh on YouTube', Icon: YouTubeIcon },
] as const;

export function SiteFooter() {
  return (
    <footer className="bg-forest text-cream">
      <div className="mx-auto max-w-[1600px] px-6 lg:px-10 xl:px-14 pt-16 pb-10 lg:pt-20">
        <div className="grid gap-10 lg:grid-cols-[1.3fr_repeat(3,0.8fr)_1.2fr]">
          <div>
            <Logo tone="light" />
            <p className="mt-4 text-[15px] text-cream/70">The messenger for your shop.</p>
            <div className="mt-6 flex gap-3">
              {SOCIALS.map(({ href, label, Icon }) => (
                <a
                  key={label}
                  href={href}
                  aria-label={label}
                  rel="me noreferrer"
                  target="_blank"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full text-cream/80 transition-colors hover:bg-white/10 hover:text-cream"
                >
                  <Icon className="h-5 w-5" />
                </a>
              ))}
            </div>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.heading}>
              <h2 className="text-[15px] font-bold tracking-wide text-cream">{column.heading}</h2>
              <ul className="mt-5 space-y-3">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-[15px] text-cream/70 transition-colors hover:text-cream"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
                {'muted' in column ? (
                  <li className="text-[15px] text-cream/40">{column.muted}</li>
                ) : null}
              </ul>
            </div>
          ))}

          <div>
            <h2 className="text-[15px] font-bold tracking-wide text-cream">Stay updated</h2>
            {/* No mailing list yet: this hands the address to the contact page rather than
                pretending to subscribe anyone. Point it at a list when one exists. */}
            <form action="/contact" method="get" className="mt-4">
              <div className="flex items-center gap-2 rounded-full bg-white/10 p-1.5 pl-4 ring-1 ring-cream/20 focus-within:ring-cream/50">
                <label htmlFor="footer-email" className="sr-only">
                  Your email address
                </label>
                <input
                  id="footer-email"
                  name="email"
                  type="email"
                  required
                  placeholder="Enter your email"
                  className="w-full min-w-0 bg-transparent py-1.5 text-[15px] text-cream placeholder:text-cream/45 focus:outline-none"
                />
                <button
                  type="submit"
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-mint text-forest transition-colors hover:bg-white"
                >
                  <span className="sr-only">Submit</span>
                  <ArrowRightIcon className="h-4 w-4" />
                </button>
              </div>
            </form>
            <p className="mt-3 text-[14px] text-cream/55">We’ll only send important updates.</p>
          </div>
        </div>

        <div className="mt-12 flex flex-wrap gap-x-5 gap-y-2 border-t border-cream/12 pt-6">
          {SMALL_PRINT.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="text-[12.5px] text-cream/55 transition-colors hover:text-cream"
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="mt-5 flex flex-col gap-2 text-[12.5px] text-cream/45 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Naaradh. All rights reserved.</p>
          <p>Made for Indian ecommerce 🇮🇳</p>
        </div>
      </div>
    </footer>
  );
}
