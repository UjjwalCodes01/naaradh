import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Naaradh — AI voice agent for commerce', template: '%s · Naaradh' },
  description:
    'Naaradh answers your store’s phone line and confirms COD orders by phone, with an AI voice agent built around Indian telecom rules.',
  robots: { index: true, follow: true },
};

/**
 * Reading headers() makes every route dynamic, which is what the nonce-based CSP in
 * middleware.ts needs: Next stamps the per-request nonce on its own scripts.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
