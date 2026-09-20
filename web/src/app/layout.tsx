import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Caveat, Noto_Sans_Devanagari, Plus_Jakarta_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

/**
 * Both faces are self-hosted by next/font at build time — no request to Google at runtime, which
 * is what `font-src 'self'` in middleware.ts allows and what keeps the site fast on 4G.
 */
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jakarta',
});

/** Hindi on the product page's call snippets; Jakarta has no Devanagari glyphs. */
const devanagari = Noto_Sans_Devanagari({
  subsets: ['devanagari'],
  weight: ['400', '600'],
  display: 'swap',
  variable: '--font-deva',
});

/** Only for the handwritten margin notes. */
const caveat = Caveat({
  subsets: ['latin'],
  weight: ['500', '600'],
  display: 'swap',
  variable: '--font-caveat',
});

export const metadata: Metadata = {
  title: { default: 'Naaradh — AI voice agent for commerce', template: '%s · Naaradh' },
  description:
    'Naaradh answers your store’s phone line and confirms COD orders by phone, with an AI voice agent built around Indian telecom rules.',
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    siteName: 'Naaradh',
    title: 'Naaradh — AI voice agent for commerce',
    description:
      'Answer customer calls 24/7, confirm COD orders and reduce returns — in Hindi, English or Hinglish.',
  },
};

/**
 * Reading headers() makes every route dynamic, which is what the nonce-based CSP in
 * middleware.ts needs: Next stamps the per-request nonce on its own scripts.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await headers();
  return (
    <html lang="en" className={`${jakarta.variable} ${devanagari.variable} ${caveat.variable}`}>
      <body>{children}</body>
    </html>
  );
}
