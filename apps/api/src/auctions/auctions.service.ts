import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/principal';
import { ApiError } from '../common/api-error';
import { DbService } from '../db/db.service';

const TERMS_OPEN_STATUSES = ['scheduled', 'live'];
const FINALIZABLE_STATUSES = ['closed', 'under_review'];

/** Every query below runs under the caller's identity, so RLS decides visibility: a customer only ever sees
 *  non-draft auctions they are invited to, and only their own results and invoices. */
@Injectable()
export class AuctionsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  // ---------------- customer ----------------

  listForCustomer(p: Principal) {
    return this.db.withPrincipal(p, async (c) => (await c.query(
      `SELECT a.id, a.number, a.name, a.status, a.start_at, a.close_at, a.bid_visibility, ap.terms_accepted_at
         FROM auctions a LEFT JOIN auction_participants ap ON ap.auction_id = a.id AND ap.customer_id = $1
        ORDER BY a.start_at DESC LIMIT 200`, [p.customerId])).rows);
  }

  getForCustomer(p: Principal, auctionId: string) {
    return this.db.withPrincipal(p, async (c) => {
      const auction = (await c.query(
        `SELECT a.id, a.number, a.name, a.status, a.start_at, a.close_at, a.bid_visibility, ap.terms_accepted_at
           FROM auctions a LEFT JOIN auction_participants ap ON ap.auction_id = a.id AND ap.customer_id = $2
          WHERE a.id = $1`, [auctionId, p.customerId])).rows[0];
      if (!auction) throw new ApiError('AUCTION_NOT_FOUND', 'Auction not found.', 404);
      const lots = (await c.query(
        `SELECT id, lot_number, description, quantity, starting_price, status FROM auction_lots
          WHERE auction_id = $1 ORDER BY lot_number`, [auctionId])).rows;
      return { ...auction, lots };
    });
  }

  /** Idempotent: the FIRST acceptance time is the record (the database refuses to change it afterwards). */
  acceptTerms(p: Principal, auctionId: string, ip?: string) {
    return this.db.withPrincipal(p, async (c) => {
      const auction = (await c.query('SELECT status FROM auctions WHERE id = $1', [auctionId])).rows[0];
      const part = auction && (await c.query(
        'SELECT is_allowed, terms_accepted_at FROM auction_participants WHERE auction_id = $1 AND customer_id = $2',
        [auctionId, p.customerId])).rows[0];
      if (!part?.is_allowed) throw new ApiError('AUCTION_NOT_FOUND', 'Auction not found.', 404);
      if (part.terms_accepted_at) return { auctionId, termsAcceptedAt: new Date(part.terms_accepted_at).toISOString(), replayed: true };
      if (!TERMS_OPEN_STATUSES.includes(auction.status)) throw new ApiError('AUCTION_NOT_OPEN', 'Terms can no longer be accepted for this auction.', 409);

      const updated = (await c.query(
        `UPDATE auction_participants SET terms_accepted_at = now()
          WHERE auction_id = $1 AND customer_id = $2 AND terms_accepted_at IS NULL RETURNING terms_accepted_at`,
        [auctionId, p.customerId])).rows[0];
      if (!updated) {
        // Either a teammate accepted concurrently (theirs is the record), or RLS refused this identity the update.
        const again = (await c.query('SELECT terms_accepted_at FROM auction_participants WHERE auction_id = $1 AND customer_id = $2', [auctionId, p.customerId])).rows[0];
        if (!again?.terms_accepted_at) throw new ApiError('FORBIDDEN', 'You are not allowed to accept terms for this auction.', 403);
        return { auctionId, termsAcceptedAt: new Date(again.terms_accepted_at).toISOString(), replayed: true };
      }
      await this.audit.record(c, { actor: p, action: 'auction.terms_accepted', referenceType: 'auction', referenceId: auctionId, ip });
      return { auctionId, termsAcceptedAt: new Date(updated.terms_accepted_at).toISOString(), replayed: false };
    });
  }

  /** The lots this customer won. Empty until the auction has closed (RLS shows a result only to its winner). */
  myResults(p: Principal, auctionId: string) {
    return this.db.withPrincipal(p, async (c) => {
      const auction = (await c.query('SELECT status FROM auctions WHERE id = $1', [auctionId])).rows[0];
      if (!auction) throw new ApiError('AUCTION_NOT_FOUND', 'Auction not found.', 404);
      const lots = (await c.query(
        `SELECT r.lot_id, l.lot_number, l.description, r.quantity, r.unit_price, r.total
           FROM lot_results r JOIN auction_lots l ON l.id = r.lot_id
          WHERE r.auction_id = $1 AND r.outcome = 'won' ORDER BY l.lot_number`, [auctionId])).rows;
      return { auctionId, status: auction.status, lotsWon: lots };
    });
  }

  // ---------------- staff ----------------

  results(p: Principal, auctionId: string) {
    return this.db.withPrincipal(p, async (c) => {
      const auction = (await c.query('SELECT id, number, name, status, close_at FROM auctions WHERE id = $1', [auctionId])).rows[0];
      if (!auction) throw new ApiError('AUCTION_NOT_FOUND', 'Auction not found.', 404);
      const lots = (await c.query(
        `SELECT r.lot_id, l.lot_number, l.description, r.outcome, r.quantity, r.unit_price, r.total, r.winning_bid_id,
                r.winner_customer_id, cu.code AS winner_code, cu.company_name AS winner_name
           FROM lot_results r JOIN auction_lots l ON l.id = r.lot_id LEFT JOIN customers cu ON cu.id = r.winner_customer_id
          WHERE r.auction_id = $1 ORDER BY l.lot_number`, [auctionId])).rows;
      return { ...auction, lots };
    });
  }

  /** closed/under_review → finalized: one invoice per winning customer, one line per won lot, all in one transaction. */
  finalize(p: Principal, auctionId: string, ip?: string) {
    return this.db.withPrincipal(p, async (c) => {
      const auction = (await c.query('SELECT id, number, status FROM auctions WHERE id = $1 FOR UPDATE', [auctionId])).rows[0];
      if (!auction) throw new ApiError('AUCTION_NOT_FOUND', 'Auction not found.', 404);
      if (auction.status === 'finalized') throw new ApiError('ALREADY_FINALIZED', 'This auction is already finalised.', 409);
      if (!FINALIZABLE_STATUSES.includes(auction.status)) throw new ApiError('AUCTION_NOT_CLOSED', 'Only a closed auction can be finalised.', 409);

      const winners = (await c.query(
        `SELECT r.winner_customer_id AS customer_id, cu.code, sum(r.total)::text AS total, count(*)::int AS lots
           FROM lot_results r JOIN customers cu ON cu.id = r.winner_customer_id
          WHERE r.auction_id = $1 AND r.outcome = 'won' GROUP BY r.winner_customer_id, cu.code ORDER BY cu.code`, [auctionId])).rows;

      const invoices = [];
      for (const w of winners) {
        const inv = (await c.query(
          `INSERT INTO invoices (invoice_number, customer_id, total_amount, auction_id) VALUES ($1,$2,$3,$4)
           RETURNING id, invoice_number, customer_id, total_amount::text AS total_amount`,
          [`INV-${auction.number}-${w.code}`, w.customer_id, w.total, auctionId])).rows[0];
        await c.query(
          `INSERT INTO invoice_lines (invoice_id, lot_id, quantity, unit_price, amount)
           SELECT $1, lot_id, quantity, unit_price, total FROM lot_results
            WHERE auction_id = $2 AND outcome = 'won' AND winner_customer_id = $3`, [inv.id, auctionId, w.customer_id]);
        invoices.push({ id: inv.id, invoiceNumber: inv.invoice_number, customerId: inv.customer_id, totalAmount: inv.total_amount, lots: w.lots });
      }
      await c.query("UPDATE auctions SET status = 'finalized' WHERE id = $1", [auctionId]);
      await this.audit.record(c, {
        actor: p, action: 'auction.finalize', referenceType: 'auction', referenceId: auctionId, ip,
        before: { status: auction.status }, after: { status: 'finalized', invoices: invoices.map((i) => ({ invoiceNumber: i.invoiceNumber, totalAmount: i.totalAmount })) },
      });
      return { auctionId, status: 'finalized', invoices };
    });
  }
}
