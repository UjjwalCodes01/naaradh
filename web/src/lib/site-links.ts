/**
 * Every destination the marketing site points at, in one place.
 *
 * Some of these are placeholders until the thing they point at exists: the Shopify listing is
 * not published yet, and there is no blog, careers page or help centre. They point at /contact
 * so nobody lands on a 404 — change the value here when the real page exists, and every button
 * across the site follows.
 */
export const LINKS = {
  /** TODO: the Shopify App Store listing, once the app is published (go-live 04). */
  shopifyInstall: '/contact',
  talkToUs: '/contact',
  pricing: '/pricing',
  signIn: '/login',
  compliance: '/security',
  doNotCall: '/do-not-call',
  /** TODO: a real FAQ page. */
  allFaqs: '/contact',
  /** TODO: a page listing every use case; today the homepage section is the whole list. */
  useCases: '/contact',
  /** TODO: blog, careers and help centre do not exist yet. */
  blog: '/contact',
  careers: '/contact',
  helpCentre: '/contact',
  about: '/contact',
  social: {
    linkedin: 'https://www.linkedin.com/company/naaradh',
    x: 'https://x.com/naaradh',
    youtube: 'https://www.youtube.com/@naaradh',
  },
} as const;

export const NAV = [
  { href: '/product', label: 'Product' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/#faq', label: 'Resources' },
  { href: '/contact', label: 'Company' },
] as const;
