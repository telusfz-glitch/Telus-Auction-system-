import { NextResponse, type NextRequest } from 'next/server';
import { keyOf, randomId, safeReturnTo } from '@/lib/crypto';
import { isSecureOrigin } from '@/lib/env';
import { STEP_UP_COOKIE } from '@/lib/api';
import { client, oidc, redirectUri } from '@/lib/oidc';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';
const LOGIN_COOKIE = 'telus_login';

/**
 * Starts the Authorization Code flow with PKCE (S256), state and nonce. The verifier and nonce stay on this server
 * (Redis, 10 minutes); the browser gets only the state, in an HttpOnly cookie that the callback must present, so a
 * callback URL planted by an attacker cannot log the victim into the attacker's account.
 */
export async function GET(req: NextRequest) {
  const config = await oidc();
  const state = randomId();
  const nonce = randomId();
  const verifier = client.randomPKCECodeVerifier();
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get('returnTo'));
  // Step-up: the API wants proof of the authenticator; make Keycloak re-authenticate instead of reusing its SSO cookie.
  const stepUp = req.nextUrl.searchParams.get('stepup') === '1';
  await (await redis()).set(keyOf('login', state), JSON.stringify({ nonce, verifier, returnTo }), { EX: 600 });

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(),
    scope: 'openid profile email',
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
    ...(stepUp ? { prompt: 'login' } : {}),
  });
  const res = NextResponse.redirect(url, 303);
  res.cookies.set(LOGIN_COOKIE, state, { httpOnly: true, secure: isSecureOrigin(), sameSite: 'lax', path: '/auth/callback', maxAge: 600 });
  if (stepUp) res.cookies.set(STEP_UP_COOKIE, '1', { httpOnly: true, secure: isSecureOrigin(), sameSite: 'lax', path: '/', maxAge: 60 });
  res.headers.set('cache-control', 'no-store');
  return res;
}
