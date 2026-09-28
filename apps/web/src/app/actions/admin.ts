'use server';

import {
  BracketsSchema, CreateAuctionSchema, CreateCustomerSchema, CreateLotsSchema, InviteCustomersSchema, SetCustomerLimitSchema,
  UpdateCustomerSchema, UpdateSecuritySettingsSchema,
} from '@telus/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { ZodError } from 'zod';
import { api, asAction, type ActionResult } from '@/lib/api';
import { requireSession } from '@/lib/auth';
import { parseMoney } from '@/lib/format';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: FormDataEntryValue | null) => (typeof v === 'string' && UUID.test(v) ? v : null);
const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v.trim() : '');
const int = (v: FormDataEntryValue | null) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);
const invalid = (e: ZodError): ActionResult =>
  ({ ok: false, message: `Please check: ${e.issues.map((i) => `${i.path.join('.') || 'input'} — ${i.message}`).join('; ')}` });

// ---------------- auctions ----------------

export async function createAuctionAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('staff');
  const input = CreateAuctionSchema.safeParse({
    number: str(form.get('number')), name: str(form.get('name')),
    startAt: str(form.get('startAt')), closeAt: str(form.get('closeAt')),
    bidVisibility: str(form.get('bidVisibility')) || undefined,
    extensionEnabled: form.get('extensionEnabled') === 'on',
    extensionWindowSeconds: int(form.get('extensionWindowSeconds')), extensionSeconds: int(form.get('extensionSeconds')),
  });
  if (!input.success) return invalid(input.error);
  let createdId = '';
  const res = await asAction(async () => {
    createdId = (await api<{ id: string }>(s, '/admin/auctions', { method: 'POST', body: input.data })).id;
    return 'Created.';
  });
  if (res?.ok) redirect(`/admin/auctions/${createdId}`);
  return res;
}

const TRANSITIONS = { schedule: 'Scheduled.', unschedule: 'Moved back to draft.', cancel: 'Auction cancelled.', finalize: 'Finalised: invoices created.' } as const;

export async function auctionTransitionAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('staff');
  const auctionId = id(form.get('auctionId'));
  const op = str(form.get('op')) as keyof typeof TRANSITIONS;
  if (!auctionId || !(op in TRANSITIONS)) return { ok: false, message: 'Invalid request.' };
  const res = await asAction(async () => {
    await api(s, `/admin/auctions/${auctionId}/${op}`, { method: 'POST' });
    return TRANSITIONS[op];
  });
  revalidatePath(`/admin/auctions/${auctionId}`);
  return res;
}

// ---------------- lots ----------------

export async function addLotAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('staff');
  const auctionId = id(form.get('auctionId'));
  if (!auctionId) return { ok: false, message: 'Invalid request.' };
  const input = CreateLotsSchema.safeParse({ lots: [{
    lotNumber: str(form.get('lotNumber')), description: str(form.get('description')), quantity: int(form.get('quantity')),
    startingPrice: parseMoney(form.get('startingPrice')) ?? NaN,
    ...(str(form.get('fallbackIncrement')) ? { fallbackIncrement: parseMoney(form.get('fallbackIncrement')) ?? NaN } : {}),
  }] });
  if (!input.success) return invalid(input.error);
  const res = await asAction(async () => {
    await api(s, `/admin/auctions/${auctionId}/lots`, { method: 'POST', body: input.data });
    return `Lot ${input.data.lots[0]!.lotNumber} added.`;
  });
  revalidatePath(`/admin/auctions/${auctionId}`);
  return res;
}

export async function lotAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('staff');
  const auctionId = id(form.get('auctionId'));
  const lotId = id(form.get('lotId'));
  const op = str(form.get('op'));
  if (!auctionId || !lotId || !['withdraw', 'delete'].includes(op)) return { ok: false, message: 'Invalid request.' };
  const res = await asAction(async () => {
    if (op === 'withdraw') await api(s, `/admin/lots/${lotId}/withdraw`, { method: 'POST' });
    else await api(s, `/admin/lots/${lotId}`, { method: 'DELETE' });
    return op === 'withdraw' ? 'Lot withdrawn.' : 'Lot deleted.';
  });
  revalidatePath(`/admin/auctions/${auctionId}`);
  return res;
}

// ---------------- invitations ----------------

export async function inviteAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('staff');
  const auctionId = id(form.get('auctionId'));
  if (!auctionId) return { ok: false, message: 'Invalid request.' };
  const input = InviteCustomersSchema.safeParse({ customerIds: form.getAll('customerIds').filter((v) => typeof v === 'string') });
  if (!input.success) return { ok: false, message: 'Choose at least one customer.' };
  const res = await asAction(async () => {
    await api(s, `/admin/auctions/${auctionId}/participants`, { method: 'POST', body: input.data });
    return `${input.data.customerIds.length} customer(s) invited.`;
  });
  revalidatePath(`/admin/auctions/${auctionId}`);
  return res;
}

export async function revokeAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('staff');
  const auctionId = id(form.get('auctionId'));
  const customerId = id(form.get('customerId'));
  if (!auctionId || !customerId) return { ok: false, message: 'Invalid request.' };
  const res = await asAction(async () => {
    await api(s, `/admin/auctions/${auctionId}/participants/${customerId}`, { method: 'DELETE' });
    return 'Invitation revoked.';
  });
  revalidatePath(`/admin/auctions/${auctionId}`);
  return res;
}

// ---------------- customers ----------------

export async function createCustomerAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('staff');
  const input = CreateCustomerSchema.safeParse({ companyName: str(form.get('companyName')), contactEmail: str(form.get('contactEmail')) });
  if (!input.success) return invalid(input.error);
  const res = await asAction(async () => {
    const c = await api<{ code: string }>(s, '/admin/customers', { method: 'POST', body: input.data });
    return `Customer ${c.code} created (pending).`;
  });
  revalidatePath('/admin/customers');
  return res;
}

export async function updateCustomerAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('staff');
  const customerId = id(form.get('customerId'));
  if (!customerId) return { ok: false, message: 'Invalid request.' };
  const rs = str(form.get('marginRuleSetId'));
  const input = UpdateCustomerSchema.safeParse({
    ...(str(form.get('status')) ? { status: str(form.get('status')) } : {}),
    ...(rs ? { marginRuleSetId: rs } : {}),   // empty = leave unchanged
  });
  if (!input.success) return invalid(input.error);
  const res = await asAction(async () => {
    await api(s, `/admin/customers/${customerId}`, { method: 'PATCH', body: input.data });
    return 'Saved.';
  });
  revalidatePath('/admin/customers');
  return res;
}

export async function setLimitAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('staff');
  const customerId = id(form.get('customerId'));
  if (!customerId) return { ok: false, message: 'Invalid request.' };
  const input = SetCustomerLimitSchema.safeParse({ maxPurchaseValue: parseMoney(form.get('maxPurchaseValue')) ?? NaN });
  if (!input.success) return { ok: false, message: 'Enter an amount (0 = cannot bid).' };
  const res = await asAction(async () => {
    await api(s, `/admin/customers/${customerId}/limits`, { method: 'PUT', body: input.data });
    return 'Limit saved.';
  });
  revalidatePath('/admin/customers');
  return res;
}

// ---------------- settings ----------------

export async function updateSecurityAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('staff');
  const input = UpdateSecuritySettingsSchema.safeParse({
    maxBidLimit: parseMoney(form.get('maxBidLimit')) ?? NaN,
    rangeEnabled: form.get('rangeEnabled') === 'on',
    rangeMin: parseMoney(form.get('rangeMin')) ?? NaN,
    rangeMax: parseMoney(form.get('rangeMax')) ?? NaN,
  });
  if (!input.success) return invalid(input.error);
  const res = await asAction(async () => {
    await api(s, '/admin/security-settings', { method: 'PATCH', body: input.data });
    return 'Security settings saved.';
  });
  revalidatePath('/admin/settings');
  return res;
}

/** Brackets as text, one per line: "from, to, margin" (e.g. "0, 500, 5"). */
function parseBrackets(text: string) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [f, t, m] = line.split(/[,;\t]/).map((x) => parseMoney(x.trim()) ?? NaN);
    return { priceFrom: f ?? NaN, priceTo: t ?? NaN, margin: m ?? NaN };
  });
}

export async function createRuleSetAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('staff');
  const brackets = BracketsSchema.safeParse({ brackets: parseBrackets(str(form.get('brackets'))) });
  if (!brackets.success) return { ok: false, message: 'Brackets: one per line as "from, to, margin", each "to" greater than its "from".' };
  const res = await asAction(async () => {
    await api(s, '/admin/margin-rule-sets', { method: 'POST', body: { name: str(form.get('name')), brackets: brackets.data.brackets } });
    return 'Margin rule set created.';
  });
  revalidatePath('/admin/settings');
  return res;
}
