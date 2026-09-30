import { AUCTION_MANAGERS, CUSTOMER_BIDDERS } from '@telus/shared';
import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession, toViewer, type Session, type Viewer } from './session';

/** For pages and server actions. No session → sign in (and come back here); wrong kind of user → home. */
export async function requireSession(kind?: 'staff' | 'customer'): Promise<Session> {
  const s = await getSession();
  if (!s) {
    const path = (await headers()).get('x-pathname') ?? '/';
    redirect(`/auth/login?returnTo=${encodeURIComponent(path)}`);
  }
  if (kind && s.kind !== kind) redirect('/');
  return s;
}

export async function currentViewer(): Promise<Viewer | null> {
  const s = await getSession();
  return s ? toViewer(s) : null;
}

/** UI hint only: the API enforces every permission itself. */
export const hasRole = (v: Pick<Viewer, 'roles'>, ...roles: string[]) => v.roles.some((r) => roles.includes(r));
export const MANAGERS = AUCTION_MANAGERS;
export const BIDDERS = CUSTOMER_BIDDERS;
