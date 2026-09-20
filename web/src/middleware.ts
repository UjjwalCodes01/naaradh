import { NextResponse, type NextRequest } from 'next/server';

/**
 * Per-request CSP nonce (Next reads it from the request's Content-Security-Policy header and
 * applies it to its own scripts). No third-party script, frame or connection is allowed on any
 * page; recordings play from GCS signed URLs, the only external media origin.
 */
/**
 * Paths that need the database, Redis and the phone-hash key: the dashboard, sign-in and its
 * callback, the public do-not-call form, and the API routes. `NAARADH_SURFACE=marketing` does
 * not serve them (see lib/env.ts).
 */
const BACKED_PATHS = ['/app', '/auth', '/login', '/do-not-call', '/api'];

export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  // Read straight from process.env, never through lib/env.ts: that schema covers the whole
  // dashboard (database, Redis, keys), and the marketing deployment has none of it to validate.
  if (process.env['NAARADH_SURFACE'] === 'marketing') {
    const { pathname, search } = request.nextUrl;
    const backed = BACKED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
    if (backed) {
      const dashboard = process.env['DASHBOARD_URL'];
      // A GET is sent on to the deployment that can serve it, so a printed link — the
      // do-not-call page on a notice — keeps working. Anything else (a form post to a page this
      // host does not serve, an API call) is refused here rather than re-posted cross-origin.
      if (dashboard !== undefined && (request.method === 'GET' || request.method === 'HEAD'))
        return NextResponse.redirect(new URL(`${pathname}${search}`, dashboard), 308);
      return new NextResponse(null, { status: 404 });
    }
  }
  const dev = process.env.NODE_ENV !== 'production';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self' https://storage.googleapis.com",
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  // Dashboard pages hold tenant data: never stored by a shared or browser cache.
  if (request.nextUrl.pathname.startsWith('/app') || request.nextUrl.pathname.startsWith('/auth'))
    response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico|api/healthz|healthz).*)' }],
};
