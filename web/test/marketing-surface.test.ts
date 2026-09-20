import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { config, middleware } from '../src/middleware.js';

/**
 * `NAARADH_SURFACE=marketing` — what the Vercel deployment serves (web/.env.example,
 * docs/go-live/11-marketing-site-vercel.md). It holds no database credential, no Redis URL and
 * no key, so the paths that need them must not be served there at all: a visitor gets the
 * deployment that can answer, never a 500 from this one.
 */

const surface = (value: string | undefined, dashboard?: string) => {
  if (value === undefined) delete process.env['NAARADH_SURFACE'];
  else process.env['NAARADH_SURFACE'] = value;
  if (dashboard === undefined) delete process.env['DASHBOARD_URL'];
  else process.env['DASHBOARD_URL'] = dashboard;
};

const request = (path: string, method = 'GET') =>
  new NextRequest(new URL(`https://naaradh.com${path}`), { method });

afterEach(() => {
  surface(undefined);
});

const BACKED = ['/app', '/app/billing', '/auth/callback', '/login', '/do-not-call', '/api/dnc'];
const MARKETING = ['/', '/pricing', '/pricing/us', '/product', '/privacy', '/sitemap.xml'];

describe('marketing surface', () => {
  it('sends the paths it cannot serve to the deployment that can, keeping the path and query', () => {
    surface('marketing', 'https://app.naaradh.com');
    for (const path of BACKED) {
      const res = middleware(request(path));
      expect(res.status, path).toBe(308);
      expect(res.headers.get('location'), path).toBe(`https://app.naaradh.com${path}`);
    }
    // A printed do-not-call link may carry a region.
    expect(middleware(request('/do-not-call?region=IN')).headers.get('location')).toBe(
      'https://app.naaradh.com/do-not-call?region=IN',
    );
  });

  it('refuses a form post or an API call instead of re-posting it across origins', () => {
    surface('marketing', 'https://app.naaradh.com');
    for (const path of ['/do-not-call', '/login', '/api/dnc']) {
      const res = middleware(request(path, 'POST'));
      expect(res.status, path).toBe(404);
      expect(res.headers.get('location'), path).toBeNull();
    }
  });

  it('with no dashboard deployment to point at, they are 404 — never a 500 from a missing database', () => {
    surface('marketing');
    for (const path of BACKED) expect(middleware(request(path)).status, path).toBe(404);
  });

  it('the marketing pages themselves are served, with the same CSP as anywhere else', () => {
    surface('marketing', 'https://app.naaradh.com');
    for (const path of MARKETING) {
      const res = middleware(request(path));
      expect(res.status, path).toBe(200);
      expect(res.headers.get('location'), path).toBeNull();
      expect(res.headers.get('content-security-policy'), path).toContain("default-src 'self'");
    }
    // A path that merely starts with the same letters is not one of them.
    expect(middleware(request('/application-form')).status).toBe(200);
  });

  it('the health endpoints never reach this middleware, so uptime checks answer on either surface', () => {
    const matcher = (config.matcher as { source: string }[])[0]?.source ?? '';
    expect(matcher).toContain('api/healthz');
    expect(matcher).toContain('healthz');
  });

  it('the full surface (the default, and what Cloud Run runs) serves everything', () => {
    surface(undefined, 'https://app.naaradh.com');
    for (const path of [...BACKED, ...MARKETING]) {
      const res = middleware(request(path));
      expect(res.status, path).toBe(200);
      expect(res.headers.get('location'), path).toBeNull();
    }
    // Dashboard pages hold tenant data: never stored by a shared or browser cache.
    expect(middleware(request('/app/billing')).headers.get('cache-control')).toBe(
      'private, no-store',
    );
  });
});
