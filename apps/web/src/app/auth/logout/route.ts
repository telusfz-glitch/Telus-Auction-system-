import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { client, oidc } from '@/lib/oidc';
import { SESSION_COOKIE, destroySession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** POST only, same-origin only. Ends the local session, then the Keycloak SSO session (RP-initiated logout). */
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (origin !== new URL(env().WEB_URL).origin) return new NextResponse('Forbidden', { status: 403 });

  const session = await destroySession(req.cookies.get(SESSION_COOKIE())?.value);
  let target = `${env().WEB_URL}/`;
  if (session?.idToken) {
    target = client.buildEndSessionUrl(await oidc(), {
      id_token_hint: session.idToken,
      post_logout_redirect_uri: `${env().WEB_URL}/`,
    }).href;
  }
  const res = NextResponse.redirect(target, 303);
  res.cookies.delete(SESSION_COOKIE());
  res.headers.set('cache-control', 'no-store');
  return res;
}
