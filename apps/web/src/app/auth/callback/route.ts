import { NextResponse, type NextRequest } from 'next/server';
import { keyOf } from '@/lib/crypto';
import { env } from '@/lib/env';
import { client, oidc } from '@/lib/oidc';
import { redis } from '@/lib/redis';
import { SESSION_COOKIE, createSession, destroySession, identityFromTokens, LoginRejected, sessionCookieOptions } from '@/lib/session';

export const dynamic = 'force-dynamic';
const LOGIN_COOKIE = 'telus_login';

function fail(reason: 'expired' | 'denied' | 'error') {
  const res = NextResponse.redirect(`${env().WEB_URL}/?login=${reason}`, 303);
  res.cookies.delete({ name: LOGIN_COOKIE, path: '/auth/callback' });
  return res;
}

export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get('state') ?? '';
  const cookieState = req.cookies.get(LOGIN_COOKIE)?.value ?? '';
  if (!state || state !== cookieState) return fail('expired');

  // Single use: GETDEL means a replayed callback URL finds nothing.
  const raw = await (await redis()).getDel(keyOf('login', state));
  if (!raw) return fail('expired');
  const { nonce, verifier, returnTo } = JSON.parse(raw) as { nonce: string; verifier: string; returnTo: string };

  let sid: string;
  let maxAge: number;
  try {
    // Rebuild the URL from WEB_URL: behind a proxy req.url may carry an internal host, and the redirect_uri must match.
    const current = new URL(`${env().WEB_URL}${req.nextUrl.pathname}${req.nextUrl.search}`);
    const tokens = await client.authorizationCodeGrant(await oidc(), current, {
      pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true,
    });
    const session = identityFromTokens(tokens);
    sid = await createSession(session);
    maxAge = session.refreshExp - Math.floor(Date.now() / 1000);
  } catch (e) {
    if (e instanceof LoginRejected) return fail('denied');
    console.error('[auth] callback failed', e instanceof Error ? e.name : 'unknown');
    return fail('error');
  }

  await destroySession(req.cookies.get(SESSION_COOKIE())?.value);   // an older session in this browser ends now
  const res = NextResponse.redirect(`${env().WEB_URL}${returnTo}`, 303);
  res.cookies.set(SESSION_COOKIE(), sid, sessionCookieOptions(maxAge));
  res.cookies.delete({ name: LOGIN_COOKIE, path: '/auth/callback' });
  res.headers.set('cache-control', 'no-store');
  return res;
}
