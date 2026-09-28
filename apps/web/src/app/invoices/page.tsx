import { InvoiceTable } from '@/components/InvoiceTable';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/auth';
import { env } from '@/lib/env';
import type { Invoice } from '@/lib/types';

export default async function MyInvoices() {
  const s = await requireSession('customer');
  const invoices = await api<Invoice[]>(s, '/invoices');
  return (
    <>
      <h1>Invoices</h1>
      <p className="muted">Invoices for lots your company won. Payment instructions are sent by TELUS Finance.</p>
      <InvoiceTable invoices={invoices} tz={env().DISPLAY_TIMEZONE} showCustomer={false} canSettle={false} />
    </>
  );
}
