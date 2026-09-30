import { createRemoteJWKSet, jwtVerify } from 'jose';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { keyOf } from '@/lib/crypto';
import { redis } from '@/lib/redis';
import { destroySessionsFor } from '@/lib/session';

export const dynamic = 'force-dynamic';
const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const g = globalThis as unknown as { __telusJwks?: ReturnType<typeof createRemoteJWKSet> };

/**
 * OpenID Connect Back-Channel Logout 1.0. Keycloak POSTs a signed logout token here whenever a user's session ends —
 * sign-out elsewhere, an administrator ending sessions, or a customer admin suspending the login — and every matching
 * web session is deleted at once instead of living on until its next token refresh.
 * The token must be signed by the realm, addressed to this client, carry the back-channel event and no nonce, and
 * is accepted once (jti replay protection).
 */
export async function POST(req: NextRequest) {
  const e = env();
  const form = await req.formData().catch(() => null);
  const token = form?.get('logout_token');
  if (typeof token !== 'string' || token.length > 8192) return bad();
  try {
    g.__telusJwks ??= createRemoteJWKSet(new URL(`${e.OIDC_ISSUER}/protocol/openid-connect/certs`));
    const { payload } = await jwtVerify(token, g.__telusJwks, {
      issuer: e.OIDC_ISSUER, audience: e.OIDC_CLIENT_ID, algorithms: ['RS256'], maxTokenAge: '2 minutes', requiredClaims: ['iat', 'jti'],
    });
    const events = payload['events'] as Record<string, unknown> | undefined;
    if (!events || typeof events !== 'object' || !(BACKCHANNEL_EVENT in events) || 'nonce' in payload) return bad();
    const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
    const sid = typeof payload['sid'] === 'string' ? (payload['sid'] as string) : undefined;
    if (!sub && !sid) return bad();
    const fresh = await (await redis()).set(keyOf('bcl-jti', payload.jti!), '1', { NX: true, EX: 600 });
    if (!fresh) return bad();
    await destroySessionsFor(sid ? { sid } : { sub });
    return new NextResponse(null, { status: 200, headers: { 'cache-control': 'no-store' } });
  } catch {
    return bad();
  }
}

const bad = () => new NextResponse(null, { status: 400, headers: { 'cache-control': 'no-store' } });
