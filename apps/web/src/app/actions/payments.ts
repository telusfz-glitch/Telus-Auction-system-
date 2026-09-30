'use server';

import { redirect } from 'next/navigation';
import { ApiCallError, api, type ActionResult } from '@/lib/api';
import { requireSession } from '@/lib/auth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opens the provider's hosted payment page for one of the company's unpaid invoices. Card details are entered there,
 * never here; the invoice turns "paid" when the provider's signed confirmation reaches the API.
 */
export async function payInvoiceAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const s = await requireSession('customer');
  const invoiceId = form.get('invoiceId');
  if (typeof invoiceId !== 'string' || !UUID.test(invoiceId)) return { ok: false, message: 'Invalid request.' };
  let url: string;
  try {
    ({ url } = await api<{ url: string }>(s, `/invoices/${invoiceId}/pay`, { method: 'POST' }));
  } catch (e) {
    if (e instanceof ApiCallError) return { ok: false, message: e.message };
    throw e;
  }
  // Only ever send the browser to the provider's own checkout domain.
  if (!/^https:\/\/checkout\.stripe\.com\//.test(url)) return { ok: false, message: 'The payment page could not be opened. Please try again.' };
  redirect(url);
}
