import { Injectable } from '@nestjs/common';
import type { CreateAuctionInput, CreateLotsInput, InviteCustomersInput, UpdateAuctionInput, UpdateLotInput } from '@telus/shared';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/principal';
import { ApiError } from '../common/api-error';
import { DbService } from '../db/db.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

const EDITABLE = ['draft', 'scheduled'];
const INVITABLE = ['draft', 'scheduled', 'live'];
const money = (n: number) => n.toFixed(2);
const AUCTION_COLS = `id, number, name, status, start_at, close_at, bid_visibility, extension_enabled,
  extension_window_seconds, extension_seconds`;
const LOT_COLS = 'id, auction_id, lot_number, description, quantity, starting_price, fallback_increment, status';

/** camelCase API field → column. Only these can ever be written: the Zod schemas are .strict() as well. */
const AUCTION_FIELDS: Record<keyof UpdateAuctionInput, string> = {
  number: 'number', name: 'name', startAt: 'start_at', closeAt: 'close_at', bidVisibility: 'bid_visibility',
  extensionEnabled: 'extension_enabled', extensionWindowSeconds: 'extension_window_seconds', extensionSeconds: 'extension_seconds',
};
const LOT_FIELDS: Record<keyof UpdateLotInput, [string, (v: never) => unknown]> = {
  description: ['description', (v: string) => v], quantity: ['quantity', (v: number) => v],
  startingPrice: ['starting_price', money], fallbackIncrement: ['fallback_increment', money],
};

/**
 * Staff management of auctions, lots and invitations. Everything runs as the staff principal (RLS: staff policies),
 * is audited in the same transaction, and state rules are checked here AND by the 004_admin.sql guard triggers.
 */
@Injectable()
export class AdminAuctionsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly realtime: RealtimeGateway) {}

  private async lockAuction(c: PoolClient, id: string) {
    const a = (await c.query(`SELECT ${AUCTION_COLS} FROM auctions WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!a) throw new ApiError('AUCTION_NOT_FOUND', 'Auction not found.', 404);
    return a;
  }

  private requireStatus(a: { status: string }, allowed: string[]) {
    if (!allowed.includes(a.status)) throw new ApiError('INVALID_STATE', `Not allowed while the auction is ${a.status}.`, 409);
  }

  // ---------------- auctions ----------------

  list(p: Principal) {
    return this.db.run(p, async (c) => (await c.query(
      `SELECT a.id, a.number, a.name, a.status, a.start_at, a.close_at, a.bid_visibility,
              (SELECT count(*)::int FROM auction_lots l WHERE l.auction_id = a.id) AS lot_count,
              (SELECT count(*)::int FROM auction_participants ap WHERE ap.auction_id = a.id AND ap.is_allowed) AS participant_count
         FROM auctions a ORDER BY a.start_at DESC LIMIT 500`)).rows);
  }

  get(p: Principal, id: string) {
    return this.db.run(p, async (c) => {
      const auction = (await c.query(`SELECT ${AUCTION_COLS} FROM auctions WHERE id = $1`, [id])).rows[0];
      if (!auction) throw new ApiError('AUCTION_NOT_FOUND', 'Auction not found.', 404);
      const lots = (await c.query(
        `SELECT l.id, l.lot_number, l.description, l.quantity, l.starting_price, l.fallback_increment, l.status,
                s.highest_amount, s.bid_count, cu.code AS leader_code
           FROM auction_lots l LEFT JOIN lot_bid_state s ON s.lot_id = l.id LEFT JOIN customers cu ON cu.id = s.leader_customer_id
          WHERE l.auction_id = $1 ORDER BY l.lot_number`, [id])).rows;
      const participants = (await c.query(
        `SELECT ap.customer_id, cu.code, cu.company_name, cu.status AS customer_status, ap.is_allowed, ap.terms_accepted_at
           FROM auction_participants ap JOIN customers cu ON cu.id = ap.customer_id
          WHERE ap.auction_id = $1 ORDER BY cu.code`, [id])).rows;
      return { ...auction, lots, participants };
    });
  }

  create(p: Principal, input: CreateAuctionInput, ip?: string) {
    return this.db.run(p, async (c) => {
      const row = (await c.query(
        `INSERT INTO auctions (number, name, status, start_at, close_at, bid_visibility, extension_enabled, extension_window_seconds, extension_seconds)
         VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8) RETURNING ${AUCTION_COLS}`,
        [input.number, input.name, input.startAt, input.closeAt, input.bidVisibility, input.extensionEnabled,
          input.extensionWindowSeconds, input.extensionSeconds])).rows[0];
      await this.audit.record(c, { actor: p, action: 'auction.create', referenceType: 'auction', referenceId: row.id, after: input, ip });
      return row;
    });
  }

  update(p: Principal, id: string, input: UpdateAuctionInput, ip?: string) {
    return this.db.run(p, async (c) => {
      const before = await this.lockAuction(c, id);
      this.requireStatus(before, EDITABLE);
      const keys = Object.keys(input) as Array<keyof UpdateAuctionInput>;
      const sets = keys.map((k, i) => `${AUCTION_FIELDS[k]} = $${i + 2}`);
      const after = (await c.query(`UPDATE auctions SET ${sets.join(', ')} WHERE id = $1 RETURNING ${AUCTION_COLS}`,
        [id, ...keys.map((k) => input[k])])).rows[0];
      if (new Date(after.close_at) <= new Date(after.start_at)) throw new ApiError('INVALID_TIMES', 'closeAt must be after startAt.', 422);
      await this.audit.record(c, { actor: p, action: 'auction.update', referenceType: 'auction', referenceId: id, before: pick(before, keys), after: input, ip });
      return after;
    });
  }

  /** draft → scheduled. The scheduler takes it live at start_at (immediately, if that is already past). */
  schedule(p: Principal, id: string, ip?: string) {
    return this.db.run(p, async (c) => {
      const a = await this.lockAuction(c, id);
      this.requireStatus(a, ['draft']);
      const check = (await c.query(
        `SELECT (SELECT count(*)::int FROM auction_lots WHERE auction_id = $1 AND status = 'active') AS lots,
                (SELECT count(*)::int FROM auction_participants WHERE auction_id = $1 AND is_allowed) AS participants,
                $2::timestamptz > now() AS closes_in_future`, [id, a.close_at])).rows[0];
      if (check.lots === 0) throw new ApiError('NO_LOTS', 'Add at least one lot before scheduling.', 422);
      if (check.participants === 0) throw new ApiError('NO_PARTICIPANTS', 'Invite at least one customer before scheduling.', 422);
      if (!check.closes_in_future) throw new ApiError('INVALID_TIMES', 'The close time is already in the past.', 422);
      return this.setStatus(c, p, a, 'scheduled', ip);
    });
  }

  unschedule(p: Principal, id: string, ip?: string) {
    return this.db.run(p, async (c) => {
      const a = await this.lockAuction(c, id);
      this.requireStatus(a, ['scheduled']);
      return this.setStatus(c, p, a, 'draft', ip);
    });
  }

  /** Cancelling a LIVE auction first takes the auction lock exclusively (like the closer), so no bid is mid-flight. */
  cancel(p: Principal, id: string, ip?: string) {
    return this.db.run(p, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(auction_lock_key($1))', [id]);
      const a = await this.lockAuction(c, id);
      this.requireStatus(a, ['draft', 'scheduled', 'live']);
      return this.setStatus(c, p, a, 'cancelled', ip);
    });
  }

  private async setStatus(c: PoolClient, p: Principal, a: { id: string; status: string }, status: string, ip?: string) {
    const row = (await c.query(`UPDATE auctions SET status = $2 WHERE id = $1 RETURNING ${AUCTION_COLS}`, [a.id, status])).rows[0];
    await this.audit.record(c, { actor: p, action: `auction.${status}`, referenceType: 'auction', referenceId: a.id, before: { status: a.status }, after: { status }, ip });
    return row;
  }

  // ---------------- lots ----------------

  addLots(p: Principal, auctionId: string, input: CreateLotsInput, ip?: string) {
    return this.db.run(p, async (c) => {
      const a = await this.lockAuction(c, auctionId);
      this.requireStatus(a, EDITABLE);
      const rows = (await c.query(
        `INSERT INTO auction_lots (auction_id, lot_number, description, quantity, starting_price, fallback_increment)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::int[], $5::numeric[], $6::numeric[])
         RETURNING ${LOT_COLS}`,
        [auctionId, input.lots.map((l) => l.lotNumber), input.lots.map((l) => l.description), input.lots.map((l) => l.quantity),
          input.lots.map((l) => money(l.startingPrice)), input.lots.map((l) => money(l.fallbackIncrement))])).rows;
      await this.audit.record(c, { actor: p, action: 'lot.create', referenceType: 'auction', referenceId: auctionId, after: { count: rows.length, lotNumbers: rows.map((r) => r.lot_number) }, ip });
      return rows;
    });
  }

  private async lockLot(c: PoolClient, lotId: string) {
    const lot = (await c.query(`SELECT ${LOT_COLS} FROM auction_lots WHERE id = $1`, [lotId])).rows[0];
    if (!lot) throw new ApiError('LOT_NOT_FOUND', 'Lot not found.', 404);
    // Same per-lot key as the bid engine and trigger, so a lot change and a bid on it are strictly ordered.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lotId]);
    const auction = await this.lockAuction(c, lot.auction_id);
    return { lot: (await c.query(`SELECT ${LOT_COLS} FROM auction_lots WHERE id = $1`, [lotId])).rows[0], auction };
  }

  updateLot(p: Principal, lotId: string, input: UpdateLotInput, ip?: string) {
    return this.db.run(p, async (c) => {
      const { lot, auction } = await this.lockLot(c, lotId);
      this.requireStatus(auction, EDITABLE);
      const keys = Object.keys(input) as Array<keyof UpdateLotInput>;
      const sets = keys.map((k, i) => `${LOT_FIELDS[k][0]} = $${i + 2}`);
      const after = (await c.query(`UPDATE auction_lots SET ${sets.join(', ')} WHERE id = $1 RETURNING ${LOT_COLS}`,
        [lotId, ...keys.map((k) => (LOT_FIELDS[k][1] as (v: unknown) => unknown)(input[k]))])).rows[0];
      await this.audit.record(c, { actor: p, action: 'lot.update', referenceType: 'lot', referenceId: lotId, before: pick(lot, keys.map((k) => LOT_FIELDS[k][0])), after: input, ip });
      return after;
    });
  }

  deleteLot(p: Principal, lotId: string, ip?: string) {
    return this.db.run(p, async (c) => {
      const { lot, auction } = await this.lockLot(c, lotId);
      this.requireStatus(auction, EDITABLE);
      await c.query('DELETE FROM auction_lots WHERE id = $1', [lotId]);
      await this.audit.record(c, { actor: p, action: 'lot.delete', referenceType: 'lot', referenceId: lotId, before: lot, ip });
      return { id: lotId, deleted: true };
    });
  }

  /** Allowed up to and including LIVE. Bids already placed stay in the ledger; the lot is allocated as 'withdrawn'. */
  withdrawLot(p: Principal, lotId: string, ip?: string) {
    return this.db.run(p, async (c) => {
      const { lot, auction } = await this.lockLot(c, lotId);
      this.requireStatus(auction, ['draft', 'scheduled', 'live']);
      if (lot.status === 'withdrawn') return lot;
      const after = (await c.query(`UPDATE auction_lots SET status = 'withdrawn' WHERE id = $1 RETURNING ${LOT_COLS}`, [lotId])).rows[0];
      await this.audit.record(c, { actor: p, action: 'lot.withdraw', referenceType: 'lot', referenceId: lotId, before: { status: lot.status }, after: { status: 'withdrawn' }, ip });
      return after;
    });
  }

  // ---------------- invitations ----------------

  /** Invites (or re-admits) customers. Terms acceptance is kept: a re-admitted customer does not have to accept again. */
  invite(p: Principal, auctionId: string, input: InviteCustomersInput, ip?: string) {
    return this.db.run(p, async (c) => {
      const a = await this.lockAuction(c, auctionId);
      this.requireStatus(a, INVITABLE);
      const ids = [...new Set(input.customerIds.map((x) => x.toLowerCase()))];
      const found = (await c.query('SELECT id FROM customers WHERE id = ANY($1::uuid[])', [ids])).rows.length;
      if (found !== ids.length) throw new ApiError('CUSTOMER_NOT_FOUND', 'One or more customers do not exist.', 422);
      await c.query(
        `INSERT INTO auction_participants (auction_id, customer_id, is_allowed) SELECT $1, unnest($2::uuid[]), true
         ON CONFLICT (auction_id, customer_id) DO UPDATE SET is_allowed = true`, [auctionId, ids]);
      await this.audit.record(c, { actor: p, action: 'auction.invite', referenceType: 'auction', referenceId: auctionId, after: { customerIds: ids }, ip });
      return { auctionId, invited: ids.length };
    });
  }

  /** Revokes (never deletes: the row is evidence of who was invited, and bids may reference the auction). After the
   *  commit, the customer's open sockets are pulled out of the auction's realtime room. */
  async revoke(p: Principal, auctionId: string, customerId: string, ip?: string) {
    const result = await this.db.run(p, async (c) => {
      const a = await this.lockAuction(c, auctionId);
      this.requireStatus(a, INVITABLE);
      const r = await c.query('UPDATE auction_participants SET is_allowed = false WHERE auction_id = $1 AND customer_id = $2 AND is_allowed', [auctionId, customerId]);
      if (r.rowCount) await this.audit.record(c, { actor: p, action: 'auction.revoke', referenceType: 'auction', referenceId: auctionId, after: { customerId }, ip });
      return { auctionId, customerId, revoked: (r.rowCount ?? 0) > 0 };
    });
    this.realtime.evict(customerId, auctionId);
    return result;
  }
}

function pick(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const cols = keys.map((k) => (k in AUCTION_FIELDS ? AUCTION_FIELDS[k as keyof UpdateAuctionInput] : k));
  return Object.fromEntries(cols.map((k) => [k, row[k]]));
}
