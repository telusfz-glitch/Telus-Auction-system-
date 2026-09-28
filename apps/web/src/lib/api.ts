import 'server-only';
import { redirect } from 'next/navigation';
import { env } from './env';
import type { Session } from './session';

/** A deliberate API refusal: `code` is stable, `message` is safe to show. */
export class ApiCallError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Server-side call to the API with the user's access token. The token never leaves this server. */
// Server errors whose API message is written for users (no internals) and tells them what to do.
const SAFE_5XX = new Set(['INVITE_EMAIL_FAILED']);

export async function api<T>(session: Session, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${env().API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) redirect('/auth/login');
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = typeof body?.code === 'string' ? body.code : `HTTP_${res.status}`;
    const message = res.status === 400 && Array.isArray(body?.issues)
      ? `Please check: ${body.issues.map((i: { path: string; message: string }) => `${i.path || 'input'} — ${i.message}`).join('; ')}`
      : typeof body?.message === 'string' && (res.status < 500 || SAFE_5XX.has(code)) ? body.message : 'Something went wrong. Please try again.';
    throw new ApiCallError(res.status, code, message);
  }
  return body as T;
}

/** For server actions: API refusals become a message for the form; anything else propagates. */
export type ActionResult = { ok: boolean; message: string } | null;
export async function asAction(fn: () => Promise<string>): Promise<ActionResult> {
  try {
    return { ok: true, message: await fn() };
  } catch (e) {
    if (e instanceof ApiCallError) return { ok: false, message: e.message };
    throw e;
  }
}
