import { Injectable } from '@nestjs/common';
import type { SettleInvoiceInput } from '@telus/shared';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/principal';
import { ApiError } from '../common/api-error';
import { mapPgError } from '../common/pg-errors';
import { DbService } from '../db/db.service';

const INVOICE = `i.id, i.invoice_number, i.customer_id, i.total_amount, i.status, i.created_at, i.settled_at, i.settlement_note,
  a.number AS auction_number, a.name AS auction_name, cu.code AS customer_code, cu.company_name`;
const LINES = `coalesce((SELECT json_agg(json_build_object('lotNumber', l.lot_number, 'description', l.description,
  'quantity', il.quantity, 'unitPrice', il.unit_price::text, 'amount', il.amount::text) ORDER BY l.lot_number)
  FROM invoice_lines il JOIN auction_lots l ON l.id = il.lot_id WHERE il.invoice_id = i.id), '[]') AS lines`;

/** Invoices are created only by finalisation. Customers read their own (RLS); finance settles them: unpaid → paid | void. */
@Injectable()
export class InvoicesService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private run<T>(p: Principal, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.db.withPrincipal(p, fn).catch((e) => { throw mapPgError(e); });
  }

  async list(p: Principal, status?: string) {
    if (status !== undefined && !['unpaid', 'paid', 'void'].includes(status)) throw new ApiError('BAD_FILTER', 'Unknown status.', 400);
    return this.run(p, async (c) => (await c.query(
      `SELECT ${INVOICE}, ${LINES} FROM invoices i LEFT JOIN auctions a ON a.id = i.auction_id JOIN customers cu ON cu.id = i.customer_id
        WHERE ($1::text IS NULL OR i.status = $1) ORDER BY i.created_at DESC LIMIT 500`, [status ?? null])).rows);
  }

  settle(p: Principal, id: string, input: SettleInvoiceInput, ip?: string) {
    return this.run(p, async (c) => {
      const inv = (await c.query('SELECT id, status, total_amount::text AS total FROM invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!inv) throw new ApiError('INVOICE_NOT_FOUND', 'Invoice not found.', 404);
      if (inv.status !== 'unpaid') throw new ApiError('INVALID_STATE', `This invoice is already ${inv.status}.`, 409);
      const row = (await c.query(
        `UPDATE invoices SET status = $2, settled_at = now(), settled_by = $3, settlement_note = $4 WHERE id = $1
         RETURNING id, invoice_number, status, settled_at, settlement_note`, [id, input.status, p.sub, input.note ?? null])).rows[0];
      await this.audit.record(c, { actor: p, action: `invoice.${input.status}`, referenceType: 'invoice', referenceId: id,
        before: { status: 'unpaid' }, after: { status: input.status, total: inv.total, note: input.note ?? null }, ip });
      return row;
    });
  }
}
