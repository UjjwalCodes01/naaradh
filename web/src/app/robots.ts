import type { MetadataRoute } from 'next';

/**
 * /login and /app need the database (ADR-0009): keep crawlers off them so a 500 — or, on the
 * marketing deployment, a redirect to the dashboard host — never shows up as a search result.
 * /auth is the sign-in callback, never a page worth indexing either way. /do-not-call stays
 * crawlable: anyone looking for how to stop these calls should find it.
 *
 * A Vercel preview deployment is kept out of search altogether: it is a copy of the whole site
 * on a throwaway hostname.
 */
export default function robots(): MetadataRoute.Robots {
  if (process.env['VERCEL_ENV'] === 'preview') return { rules: { userAgent: '*', disallow: '/' } };
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/app', '/app/', '/login', '/auth', '/api'],
    },
    sitemap: 'https://naaradh.com/sitemap.xml',
  };
}
