import type { MetadataRoute } from 'next';
import { LEGAL } from '@/content/legal';

const SITE = 'https://naaradh.com';

/**
 * Every page that renders with no backend (ADR-0009): the marketing pages plus every legal slug
 * in `content/legal.ts`. Some legal pages carry a "pending counsel review" banner (`draft: true`)
 * but the page itself is live and accurate today, so it stays in the sitemap. /login and /app
 * are deliberately left out — see robots.ts.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const marketing: MetadataRoute.Sitemap = [
    { url: SITE, priority: 1 },
    { url: `${SITE}/product`, priority: 0.9 },
    { url: `${SITE}/pricing`, priority: 0.9 },
    { url: `${SITE}/pricing/us`, priority: 0.7 },
    { url: `${SITE}/do-not-call`, priority: 0.5 },
  ];
  const legal: MetadataRoute.Sitemap = Object.entries(LEGAL).map(([slug, page]) => ({
    url: `${SITE}/${slug}`,
    lastModified: page.updated,
    priority: slug === 'contact' ? 0.6 : 0.3,
  }));
  return [...marketing, ...legal];
}
