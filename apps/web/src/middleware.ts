import { NextResponse, type NextRequest } from 'next/server';

/**
 * Security headers for every page, including a per-request nonce-based Content-Security-Policy (Next reads the
 * nonce from the request's CSP header and applies it to its own scripts). No inline script runs without it.
 * Authentication is NOT decided here: every page and server action checks the server-side session itself.
 */
export function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== 'production';
  const api = process.env.API_PUBLIC_URL ? new URL(process.env.API_PUBLIC_URL) : null;
  const issuer = process.env.OIDC_ISSUER ? new URL(process.env.OIDC_ISSUER).origin : '';
  const socket = api ? `${api.protocol === 'https:' ? 'wss:' : 'ws:'}//${api.host}` : '';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-inline'" : ''}`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${socket}${dev ? ' ws:' : ''}`.trim(),
    // Logout posts to /auth/logout, which redirects to Keycloak; browsers apply form-action to that redirect.
    `form-action 'self' ${issuer}`.trim(),
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('content-security-policy', csp);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('x-pathname', req.nextUrl.pathname + req.nextUrl.search);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('content-security-policy', csp);
  res.headers.set('x-content-type-options', 'nosniff');
  // same-origin (not no-referrer): with no-referrer, browsers send "Origin: null" on form POSTs, which would defeat the
  // Origin checks on /auth/logout and server actions. Other sites still never receive a referrer.
  res.headers.set('referrer-policy', 'same-origin');
  res.headers.set('x-frame-options', 'DENY');
  res.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.headers.set('cross-origin-opener-policy', 'same-origin');
  if (req.nextUrl.protocol === 'https:') res.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
  return res;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico).*)' }],
};
