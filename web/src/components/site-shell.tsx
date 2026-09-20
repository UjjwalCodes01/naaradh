import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/site/footer';
import { SiteHeader } from '@/components/site/header';

/**
 * The public site's frame. `main` is deliberately un-padded: the homepage lays out full-bleed
 * bands, and every other page wraps itself in <SitePage>.
 */
export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-cream">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
