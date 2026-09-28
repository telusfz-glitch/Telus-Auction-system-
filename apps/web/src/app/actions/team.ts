'use server';

import { CreateTeamUserSchema, SettleInvoiceSchema, UpdateTeamUserSchema } from '@telus/shared';
import { revalidatePath } from 'next/cache';
import type { ZodError } from 'zod';
import { api, asAction, type ActionResult } from '@/lib/api';
import { requireSession } from '@/lib/auth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: FormDataEntryValue | null) => (typeof v === 'string' && UUID.test(v) ? v : null);
const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v.trim() : '');
const invalid = (e: ZodError): ActionResult =>
  ({ ok: false, message: `Please check: ${e.issues.map((i) => `${i.path.join('.') || 'input'} — ${i.message}`).join('; ')}` });

/**
 * Creates a login. Customers add to their own company (/team); staff name the company (customerId field).
 * The one-time temporary password comes back in the message and is never stored by the web app.
 */
export async function createTeamUserAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession();
  const input = CreateTeamUserSchema.safeParse({
    email: str(form.get('email')), firstName: str(form.get('firstName')), lastName: str(form.get('lastName')), role: str(form.get('role')),
  });
  if (!input.success) return invalid(input.error);
  let path = '/team';
  let target = '/team';
  if (s.kind === 'staff') {
    const customerId = id(form.get('customerId'));
    if (!customerId) return { ok: false, message: 'Invalid request.' };
    path = `/admin/customers/${customerId}/users`;
    target = `/admin/customers/${customerId}`;
  }
  const res = await asAction(async () => {
    const r = await api<{ temporaryPassword: string; email: string }>(s, path, { method: 'POST', body: input.data });
    return `Login created for ${r.email}. Temporary password (shown once — share it securely): ${r.temporaryPassword}`;
  });
  revalidatePath(target);
  return res;
}

export async function updateTeamUserAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession();
  const userId = id(form.get('userId'));
  if (!userId) return { ok: false, message: 'Invalid request.' };
  const input = UpdateTeamUserSchema.safeParse({
    ...(str(form.get('role')) ? { role: str(form.get('role')) } : {}),
    ...(str(form.get('status')) ? { status: str(form.get('status')) } : {}),
  });
  if (!input.success) return invalid(input.error);
  const res = await asAction(async () => {
    await api(s, s.kind === 'staff' ? `/admin/customer-users/${userId}` : `/team/${userId}`, { method: 'PATCH', body: input.data });
    return 'Saved.';
  });
  revalidatePath(s.kind === 'staff' ? `/admin/customers/${str(form.get('customerId'))}` : '/team');
  return res;
}

export async function settleInvoiceAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('staff');
  const invoiceId = id(form.get('invoiceId'));
  if (!invoiceId) return { ok: false, message: 'Invalid request.' };
  const input = SettleInvoiceSchema.safeParse({ status: str(form.get('status')), ...(str(form.get('note')) ? { note: str(form.get('note')) } : {}) });
  if (!input.success) return invalid(input.error);
  const res = await asAction(async () => {
    await api(s, `/admin/invoices/${invoiceId}/settle`, { method: 'POST', body: input.data });
    return input.data.status === 'paid' ? 'Marked as paid.' : 'Invoice voided.';
  });
  revalidatePath('/admin/invoices');
  return res;
}
