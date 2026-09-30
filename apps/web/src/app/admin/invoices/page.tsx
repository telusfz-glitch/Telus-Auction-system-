import Link from 'next/link';
import { InvoiceTable } from '@/components/InvoiceTable';
import { api } from '@/lib/api';
import { hasRole, requireSession } from '@/lib/auth';
import { env } from '@/lib/env';
import type { Invoice } from '@/lib/types';

const FILTERS = ['unpaid', 'paid', 'void'] as const;

export default async function AdminInvoices({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const s = await requireSession('staff');
  const { status } = await searchParams;
  const filter = FILTERS.find((f) => f === status);
  const invoices = await api<Invoice[]>(s, `/admin/invoices${filter ? `?status=${filter}` : ''}`);
  return (
    <>
      <h1>Invoices</h1>
      <div className="row">
        <Link href="/admin/invoices" className={filter ? '' : 'badge live'}>All</Link>
        {FILTERS.map((f) => <Link key={f} href={`/admin/invoices?status=${f}`} className={filter === f ? 'badge live' : ''}>{f}</Link>)}
      </div>
      <InvoiceTable invoices={invoices} tz={env().DISPLAY_TIMEZONE} showCustomer canSettle={hasRole(s, 'super_admin', 'finance')} />
    </>
  );
}
