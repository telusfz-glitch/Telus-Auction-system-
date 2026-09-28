import { settleInvoiceAction } from '@/app/actions/team';
import { ActionForm } from '@/components/ActionForm';
import { aed, when } from '@/lib/format';
import type { Invoice } from '@/lib/types';

const STATUS_CLASS = { unpaid: 'scheduled', paid: 'live', void: 'cancelled' } as const;

export function InvoiceTable({ invoices, tz, showCustomer, canSettle }: { invoices: Invoice[]; tz: string; showCustomer: boolean; canSettle: boolean }) {
  if (invoices.length === 0) return <p className="panel">No invoices.</p>;
  return (
    <>
      {invoices.map((i) => (
        <div key={i.id} className="panel" data-testid={`invoice-${i.invoice_number}`}>
          <div className="row spread">
            <div>
              <strong>{i.invoice_number}</strong> <span className={`badge ${STATUS_CLASS[i.status]}`}>{i.status}</span>
              <div className="muted">
                {showCustomer && <>{i.customer_code} · {i.company_name} · </>}
                {i.auction_name ? `${i.auction_name} (${i.auction_number})` : 'Manual invoice'} · issued {when(i.created_at, tz)}
                {i.settled_at && <> · {i.status} {when(i.settled_at, tz)}{i.settlement_note ? ` — ${i.settlement_note}` : ''}</>}
              </div>
            </div>
            <div style={{ fontSize: '1.2rem' }}><strong>{aed(i.total_amount)}</strong></div>
          </div>
          <table>
            <thead><tr><th>Lot</th><th>Description</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Amount</th></tr></thead>
            <tbody>{i.lines.map((l) => (
              <tr key={l.lotNumber}><td>{l.lotNumber}</td><td>{l.description}</td><td className="num">{l.quantity}</td>
                <td className="num">{aed(l.unitPrice)}</td><td className="num">{aed(l.amount)}</td></tr>
            ))}</tbody>
          </table>
          {canSettle && i.status === 'unpaid' && (
            <div className="row" style={{ marginTop: 10 }}>
              <ActionForm action={settleInvoiceAction} submit="Mark paid" hidden={{ invoiceId: i.id, status: 'paid' }}>
                <input name="note" placeholder="Payment reference" maxLength={500} aria-label={`Payment reference for ${i.invoice_number}`} />
              </ActionForm>
              <ActionForm action={settleInvoiceAction} submit="Void" variant="danger" confirm={`Void ${i.invoice_number}? This cannot be undone.`}
                hidden={{ invoiceId: i.id, status: 'void' }}>
                <input name="note" placeholder="Reason" maxLength={500} aria-label={`Void reason for ${i.invoice_number}`} />
              </ActionForm>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
