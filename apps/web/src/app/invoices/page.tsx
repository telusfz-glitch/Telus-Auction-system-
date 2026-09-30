import { InvoiceTable } from '@/components/InvoiceTable';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/auth';
import { env } from '@/lib/env';
import type { Invoice } from '@/lib/types';

export default async function MyInvoices({ searchParams }: { searchParams: Promise<{ payment?: string }> }) {
  const s = await requireSession('customer');
  const [invoices, options, { payment }] = await Promise.all([
    api<Invoice[]>(s, '/invoices'),
    api<{ card: boolean }>(s, '/payments/options'),
    searchParams,
  ]);
  const canPay = options.card && s.customerRole === 'customer_admin';
  return (
    <>
      <h1>Invoices</h1>
      {payment === 'success' && (
        <p className="msg ok" role="status" data-testid="payment-banner">
          Thank you — your card payment is being confirmed. The invoice shows as paid as soon as the payment provider confirms it.
        </p>
      )}
      {payment === 'cancelled' && <p className="msg err" role="status" data-testid="payment-banner">Payment cancelled — nothing was charged.</p>}
      <p className="muted">
        Invoices for lots your company won.{' '}
        {options.card ? (canPay ? 'Pay by card online, or by bank transfer as instructed by TELUS Finance.' : 'Your company administrator can pay by card online.')
          : 'Payment instructions are sent by TELUS Finance.'}
      </p>
      <InvoiceTable invoices={invoices} tz={env().DISPLAY_TIMEZONE} showCustomer={false} canSettle={false} canPay={canPay} />
    </>
  );
}
