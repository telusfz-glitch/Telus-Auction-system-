'use server';

import { PlaceBidSchema } from '@telus/shared';
import { revalidatePath } from 'next/cache';
import { api, asAction, type ActionResult } from '@/lib/api';
import { requireSession } from '@/lib/auth';
import { env } from '@/lib/env';
import { aed, parseMoney } from '@/lib/format';

const uuid = (v: FormDataEntryValue | null) =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;

/** Server actions are public HTTP endpoints: each one re-checks the session and re-validates its input. */
export async function acceptTermsAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('customer');
  const auctionId = uuid(form.get('auctionId'));
  if (!auctionId) return { ok: false, message: 'Invalid request.' };
  const res = await asAction(async () => {
    await api(s, `/auctions/${auctionId}/accept-terms`, { method: 'POST' });
    return 'Terms accepted. You can now bid.';
  });
  revalidatePath(`/auctions/${auctionId}`);
  return res;
}

/**
 * The idempotency key is minted by the SERVER when it renders the form, so a double-click or a retried request
 * re-sends the same key and the API records the bid at most once.
 */
export async function placeBidAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('customer');
  const auctionId = uuid(form.get('auctionId'));
  const amount = parseMoney(form.get('amount'));
  if (!auctionId) return { ok: false, message: 'Invalid request.' };
  if (amount === null) return { ok: false, message: 'Enter an amount like 1250 or 1250.50.' };
  const input = PlaceBidSchema.safeParse({ lotId: form.get('lotId'), amount, idempotencyKey: form.get('idempotencyKey') });
  if (!input.success) return { ok: false, message: 'Invalid bid.' };

  const res = await asAction(async () => {
    const r = await api<{ replayed: boolean; extended: boolean }>(s, '/bids', { method: 'POST', body: input.data });
    const amountText = aed(amount.toFixed(2));
    if (r.replayed) return `Your bid of ${amountText} was already recorded.`;
    return r.extended ? `Bid of ${amountText} placed. The auction was extended.` : `Bid of ${amountText} placed.`;
  });
  if (res?.ok) revalidatePath(`/auctions/${auctionId}`);
  return res;
}

/** A one-time socket ticket for the browser (valid 30 s, single use). The access token itself stays here. */
export async function socketTicketAction(): Promise<{ ticket: string; url: string } | null> {
  const s = await requireSession();
  try {
    const r = await api<{ ticket: string }>(s, '/socket-tickets', { method: 'POST' });
    return { ticket: r.ticket, url: env().API_PUBLIC_URL };
  } catch {
    return null;
  }
}
