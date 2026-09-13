import { NextResponse, type NextRequest } from 'next/server';

/**
 * Per-request CSP nonce (Next reads it from the request's Content-Security-Policy header and
 * applies it to its own scripts). No third-party script, frame or connection is allowed on any
 * page; recordings play from GCS signed URLs, the only external media origin.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
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
