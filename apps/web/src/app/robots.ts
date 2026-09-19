import type { MetadataRoute } from 'next';

/**
 * /login and /app need the database and are not deployed on the marketing host yet (ADR-0009);
 * keep crawlers off them so a 500 never shows up as a search result. /auth is the sign-in
 * callback, never a page worth indexing either way.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/app', '/app/', '/login', '/auth', '/api'],
    },
    sitemap: 'https://naaradh.com/sitemap.xml',
  };
}
