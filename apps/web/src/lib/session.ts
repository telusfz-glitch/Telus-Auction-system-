import 'server-only';
import { CUSTOMER_ROLE_RANK, CUSTOMER_ROLES, STAFF_ROLES } from '@telus/shared';
import { cookies } from 'next/headers';
import { keyOf, randomId, seal, unseal } from './crypto';
import { env, isSecureOrigin } from './env';
import { client, oidc } from './oidc';
import { redis } from './redis';

/**
 * Server-side sessions (backend-for-frontend). The browser holds ONLY an opaque random id in an HttpOnly cookie;
 * the Keycloak tokens live in Redis, AES-GCM encrypted, under a hash of that id. No token ever reaches browser
 * JavaScript, so an XSS bug cannot steal one.
 */
export interface Session {
  sub: string;
  name: string;
  email: string | null;
  kind: 'staff' | 'customer';
  roles: string[];
  customerId: string | null;
  customerRole: string | null;
  accessToken: string;
  accessExp: number;     // epoch seconds
  refreshToken: string | null;
  refreshExp: number;    // epoch seconds; the session ends with the refresh token
  idToken: string | null;
  /** Keycloak's session id (`sid`): back-channel logout names it. */
  kcSid: string | null;
  createdAt: number;
}
/** What UI code gets: identity and roles, never tokens. */
export type Viewer = Pick<Session, 'sub' | 'name' | 'email' | 'kind' | 'roles' | 'customerId' | 'customerRole'>;

export const SESSION_COOKIE = () => (isSecureOrigin() ? '__Host-telus_sid' : 'telus_sid');
const ABSOLUTE_MAX_SECONDS = 10 * 3600;      // matches Keycloak ssoSessionMaxLifespan
const REFRESH_MARGIN_SECONDS = 30;
const now = () => Math.floor(Date.now() / 1000);

export class LoginRejected extends Error {}

/** Same rules as the API's TokenVerifier (the API still verifies every token itself). */
export function identityFromTokens(tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers, previous?: Session): Session {
  const claims = decodePayload(tokens.access_token);
  const id = tokens.claims();
  const realmRoles: string[] = Array.isArray((claims['realm_access'] as { roles?: unknown })?.roles)
    ? ((claims['realm_access'] as { roles: unknown[] }).roles.filter((r): r is string => typeof r === 'string')) : [];
  const staff = realmRoles.filter((r) => (STAFF_ROLES as readonly string[]).includes(r));
  const customer = realmRoles.filter((r) => (CUSTOMER_ROLES as readonly string[]).includes(r));
  if (staff.length && customer.length) throw new LoginRejected('mixed staff and customer roles');
  if (!staff.length && !customer.length) throw new LoginRejected('no TELUS role');
  const customerId = typeof claims['customer_id'] === 'string' ? (claims['customer_id'] as string).toLowerCase() : null;
  if (customer.length && !customerId) throw new LoginRejected('customer account without customer_id');

  const t = now();
  const refreshIn = typeof tokens['refresh_expires_in'] === 'number' ? (tokens['refresh_expires_in'] as number) : 1800;
  const createdAt = previous?.createdAt ?? t;
  return {
    sub: String(claims['sub']),
    name: String(id?.['name'] ?? claims['name'] ?? claims['preferred_username'] ?? 'User'),
    email: typeof claims['email'] === 'string' ? (claims['email'] as string) : null,
    kind: staff.length ? 'staff' : 'customer',
    roles: staff.length ? staff : customer,
    customerId: staff.length ? null : customerId,
    customerRole: staff.length ? null : (CUSTOMER_ROLE_RANK.find((r) => customer.includes(r)) ?? null),
    accessToken: tokens.access_token,
    accessExp: typeof claims['exp'] === 'number' ? (claims['exp'] as number) : t + (tokens.expires_in ?? 60),
    refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? null,
    refreshExp: Math.min(t + refreshIn, createdAt + ABSOLUTE_MAX_SECONDS),
    idToken: tokens.id_token ?? previous?.idToken ?? null,
    kcSid: typeof id?.['sid'] === 'string' ? (id['sid'] as string) : typeof claims['sid'] === 'string' ? (claims['sid'] as string) : previous?.kcSid ?? null,
    createdAt,
  };
}

function decodePayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) throw new LoginRejected('malformed access token');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function save(sid: string, s: Session): Promise<void> {
  const ttl = Math.max(1, s.refreshExp - now());
  const r = await redis();
  const key = keyOf('sess', sid);
  // Indexes for back-channel logout: Keycloak names a user (sub) and/or one of its sessions (sid).
  const idx = [keyOf('sess-sub', s.sub), ...(s.kcSid ? [keyOf('sess-kcsid', s.kcSid)] : [])];
  const m = r.multi().set(key, seal(JSON.stringify(s), env().SESSION_SECRET), { EX: ttl });
  for (const i of idx) m.sAdd(i, key).expire(i, ABSOLUTE_MAX_SECONDS);
  await m.exec();
}

/**
 * Back-channel logout: ends every web session of a Keycloak session (`sid`) or, without one, of a user (`sub`).
 * Returns how many sessions were ended.
 */
export async function destroySessionsFor(target: { sub?: string; sid?: string }): Promise<number> {
  const r = await redis();
  const idx = target.sid ? keyOf('sess-kcsid', target.sid) : target.sub ? keyOf('sess-sub', target.sub) : null;
  if (!idx) return 0;
  const keys = await r.sMembers(idx);
  if (keys.length) await r.del(keys);
  await r.del(idx);
  return keys.length;
}

async function load(sid: string): Promise<Session | null> {
  const raw = await (await redis()).get(keyOf('sess', sid));
  const json = raw ? unseal(raw, env().SESSION_SECRET) : null;
  return json ? (JSON.parse(json) as Session) : null;
}

/** Creates a brand-new session id (never reuses one: no session fixation) and returns it for the cookie. */
export async function createSession(s: Session): Promise<string> {
  const sid = randomId();
  await save(sid, s);
  return sid;
}

export async function destroySession(sid: string | undefined): Promise<Session | null> {
  if (!sid) return null;
  const r = await redis();
  const s = await load(sid);
  await r.del(keyOf('sess', sid));
  return s;
}

export function sessionCookieOptions(maxAgeSeconds: number) {
  return { httpOnly: true, secure: isSecureOrigin(), sameSite: 'lax' as const, path: '/', maxAge: maxAgeSeconds };
}

/**
 * The current session with a usable access token, or null. Refreshes the access token when it is about to expire.
 * Keycloak rotates refresh tokens and revokes on reuse, so two parallel refreshes would log the user out: a Redis
 * lock lets exactly one request refresh while the others wait for its result.
 */
export async function getSession(): Promise<Session | null> {
  const sid = (await cookies()).get(SESSION_COOKIE())?.value;
  if (!sid || sid.length > 128) return null;
  let s = await load(sid);
  if (!s) return null;
  if (s.accessExp - now() > REFRESH_MARGIN_SECONDS) return s;
  if (!s.refreshToken || s.refreshExp <= now()) { await destroySession(sid); return null; }

  const r = await redis();
  const lockKey = keyOf('sess-lock', sid);
  if (await r.set(lockKey, '1', { NX: true, PX: 10_000 })) {
    try {
      const tokens = await client.refreshTokenGrant(await oidc(), s.refreshToken);
      s = identityFromTokens(tokens, s);
      await save(sid, s);
      return s;
    } catch {
      await destroySession(sid);   // refresh refused (revoked, expired, user disabled): sign in again
      return null;
    } finally {
      await r.del(lockKey);
    }
  }
  for (let i = 0; i < 50; i++) {   // another request is refreshing: wait for it (≤5 s)
    await new Promise((res) => setTimeout(res, 100));
    const next = await load(sid);
    if (!next) return null;
    if (next.accessExp - now() > REFRESH_MARGIN_SECONDS) return next;
  }
  return null;
}

export const toViewer = (s: Session): Viewer =>
  ({ sub: s.sub, name: s.name, email: s.email, kind: s.kind, roles: s.roles, customerId: s.customerId, customerRole: s.customerRole });
