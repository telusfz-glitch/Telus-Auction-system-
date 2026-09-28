import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { PlaceBidInput } from '@telus/shared';
import { createHash } from 'crypto';
import { isIP } from 'net';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/principal';
import { DbService } from '../db/db.service';
import { fromCents, toCents } from './money';

const BIDDER_ROLES = ['customer_admin', 'customer_bidder'];

export class BidRejected extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: number,
    readonly details: Record<string, unknown> = {},
    /** Security-relevant rejections are written to the tamper-evident audit log. */
    readonly auditWorthy = false,
  ) {
    super({ statusCode: status, code, message, ...details }, status);
  }
}

export interface PlacedBid { bidId: string; replayed: boolean; closeAt: string; extended: boolean }

/** Translates the database safety-net's errors into clean API errors. */
function mapDbError(err: unknown): unknown {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'P0001' && e.message === 'AUCTION_NOT_OPEN') return new BidRejected('AUCTION_NOT_OPEN', 'This auction is not open for bidding.', 409);
  if (e?.code === 'P0001' && e.message === 'LOT_UNAVAILABLE') return new BidRejected('LOT_UNAVAILABLE', 'This lot is no longer available.', 409);
  if (e?.code === 'P0001' && e.message === 'BID_NOT_HIGHER') return new BidRejected('BID_CONFLICT', 'Another bid was placed first. Please review the current position and retry.', 409);
  return err;
}

@Injectable()
export class BidsService {
  private readonly logger = new Logger(BidsService.name);
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async place(p: Principal, input: PlaceBidInput, ip?: string): Promise<PlacedBid> {
    try {
      return await this.db.withPrincipal(p, (c) => this.placeInTx(c, p, input, ip));
    } catch (raw) {
      const err = mapDbError(raw);
      if (err instanceof BidRejected && err.auditWorthy) await this.recordRejection(p, input, err, ip);
      throw err;
    }
  }

  private async placeInTx(c: PoolClient, p: Principal, input: PlaceBidInput, ip?: string): Promise<PlacedBid> {
    if (p.kind !== 'customer' || !p.customerId || !BIDDER_ROLES.includes(p.customerRole ?? '')) {
      throw new BidRejected('FORBIDDEN', 'You are not allowed to place bids.', 403);
    }
    const customerId = p.customerId;
    const amount = toCents(input.amount.toFixed(2));
    const requestHash = createHash('sha256').update(`${input.lotId}|${amount}`).digest('hex');

    // 1. Serialise ALL of this customer's bids. This makes idempotency race-free (same key ⇒ second request
    //    waits, then sees the first) and makes the exposure check race-free across their different lots.
    //    Lock order everywhere is customer → lot, so no deadlock cycles.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`cust:${customerId}`]);

    const prior = (await c.query('SELECT id, request_hash, auction_id FROM bids WHERE customer_id = $1 AND idempotency_key = $2', [customerId, input.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) throw new BidRejected('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different bid.', 422);
      return { bidId: String(prior.id), replayed: true, closeAt: await this.closeAt(c, prior.auction_id), extended: false };
    }

    // 2. The lot must be visible to this customer (RLS: invited, non-draft). Otherwise "not found" — no enumeration.
    const lot = (await c.query('SELECT id, auction_id, quantity, starting_price::text AS starting_price, fallback_increment::text AS fallback_increment, status FROM auction_lots WHERE id = $1', [input.lotId])).rows[0];
    if (!lot) throw new BidRejected('LOT_NOT_FOUND', 'Lot not found.', 404);

    const customer = (await c.query('SELECT status FROM customers WHERE id = $1', [customerId])).rows[0];
    if (!customer || customer.status !== 'active') throw new BidRejected('CUSTOMER_NOT_ACTIVE', 'Your account is not active for bidding.', 403);
    // A suspended login is disabled in Keycloak at once, but an access token already issued lives on (≤5 min): stop it here.
    const login = (await c.query('SELECT status FROM customer_users WHERE keycloak_sub = $1', [p.sub])).rows[0];
    if (login?.status === 'suspended') throw new BidRejected('LOGIN_SUSPENDED', 'Your login has been suspended.', 403, {}, true);

    const part = (await c.query('SELECT is_allowed, terms_accepted_at FROM auction_participants WHERE auction_id = $1 AND customer_id = $2', [lot.auction_id, customerId])).rows[0];
    if (!part || !part.is_allowed) throw new BidRejected('LOT_NOT_FOUND', 'Lot not found.', 404);
    if (!part.terms_accepted_at) throw new BidRejected('TERMS_NOT_ACCEPTED', 'You must accept the auction terms before bidding.', 403);

    const auction = (await c.query('SELECT status, start_at, close_at, bid_visibility, clock_timestamp() AS now FROM auctions WHERE id = $1', [lot.auction_id])).rows[0];
    const now = new Date(auction.now).getTime();
    if (auction.status !== 'live' || now < new Date(auction.start_at).getTime() || now >= new Date(auction.close_at).getTime()) {
      throw new BidRejected('AUCTION_NOT_OPEN', 'This auction is not open for bidding.', 409);
    }
    if (lot.status !== 'active') throw new BidRejected('LOT_UNAVAILABLE', 'This lot is no longer available.', 409);

    // 3. Platform HARD limits — checked before anything else price-related, and audited when they trip.
    const st = (await c.query('SELECT max_bid_limit::text AS mx, range_enabled, range_min::text AS rmin, range_max::text AS rmax FROM security_settings')).rows[0];
    if (amount > toCents(st.mx)) {
      throw new BidRejected('MAX_BID_LIMIT', `Bids above AED ${st.mx} are not allowed.`, 422, {}, true);
    }
    if (st.range_enabled && (amount < toCents(st.rmin) || amount > toCents(st.rmax))) {
      throw new BidRejected('RANGE_LIMIT', `Bids must be between AED ${st.rmin} and AED ${st.rmax}.`, 422, {}, true);
    }

    // 4. Everything that does not depend on this lot's current price is read BEFORE taking the lot lock, so the lock is
    //    held for as few round trips as possible (a hot lot serialises every bidder on it). These reads stay race-free:
    //    the customer lock (step 1) serialises this customer's own bids, and others can only LOWER this customer's
    //    exposure (by outbidding them elsewhere), which keeps the check conservative.
    const [brackets, seen] = await Promise.all([
      c.query(
        `SELECT b.price_from::text AS f, b.price_to::text AS t, b.margin::text AS m FROM margin_rule_brackets b
           JOIN customers cu ON cu.margin_rule_set_id = b.rule_set_id WHERE cu.id = $1`, [customerId]),
      c.query('SELECT highest_amount::text AS highest FROM lot_price_state($1)', [lot.id]),
    ].map((q) => q.then((r) => r.rows)));
    const minNextAt = (highest: string | undefined) => {
      if (highest === undefined) return toCents(lot.starting_price);
      const h = toCents(highest);
      const br = brackets.find((b) => h >= toCents(b.f) && h < toCents(b.t));
      return h + toCents(br ? br.m : lot.fallback_increment);
    };
    const tooLow = (minNext: bigint) =>
      new BidRejected('BID_TOO_LOW', 'Your bid is too low.', 422, auction.bid_visibility === 'full_price' ? { minNextBid: fromCents(minNext) } : {});
    // Early rejection without the lot lock: a lot's price only ever rises (the trigger accepts strictly higher bids
    // only), so a bid already below the minimum at an earlier price is certainly too low. The authoritative check
    // is repeated under the lock below.
    const early = minNextAt(seen[0]?.highest);
    if (amount < early) throw tooLow(early);

    const [limits, other] = await Promise.all([
      c.query('SELECT max_purchase_value::text AS v FROM customer_limits WHERE customer_id = $1', [customerId]),
      c.query(
        `SELECT coalesce(sum(s.highest_amount * l.quantity), 0)::text AS total
           FROM lot_bid_state s JOIN auction_lots l ON l.id = s.lot_id JOIN auctions au ON au.id = l.auction_id
          WHERE s.leader_customer_id = $1 AND s.lot_id <> $2 AND au.status IN ('live','closing','closed','under_review')`, [customerId, lot.id]),
    ].map((q) => q.then((r) => r.rows)));
    const capacity = toCents(limits[0] ? limits[0].v : '0');
    const otherTotal = toCents(other[0].total);

    // 5. Serialise everyone bidding on THIS lot from here on; read the price only after taking the lock (a separate
    //    statement: a single statement would read the price with a snapshot taken before the lock was granted).
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lot.id]);
    const price = (await c.query('SELECT highest_amount::text AS highest FROM lot_price_state($1)', [lot.id])).rows[0];

    // The minimum next bid reveals the current price, so it is disclosed ONLY when the auction is 'full_price'.
    const minNext = minNextAt(price?.highest);
    if (amount < minNext) throw tooLow(minNext);

    // 6. Exposure: value of everything this customer currently leads (excluding this lot, which this bid replaces).
    const projected = otherTotal + amount * BigInt(lot.quantity);
    if (projected > capacity) {
      throw new BidRejected('EXPOSURE_LIMIT', 'This bid would exceed your purchasing limit.', 422, { remainingCapacity: fromCents(capacity > otherTotal ? capacity - otherTotal : 0n) }, true);
    }

    // 7. Insert. The trigger re-checks open/higher atomically and updates price, extension and outbox.
    const inserted = await c.query(
      `INSERT INTO bids (auction_id, lot_id, customer_id, acting_user_sub, amount, idempotency_key, request_hash, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [lot.auction_id, lot.id, customerId, p.sub, fromCents(amount), input.idempotencyKey, requestHash, ip && isIP(ip) ? ip : null]);
    const after = (await c.query(
      "SELECT current_setting('app.last_bid_extended', true) AS f, close_at FROM auctions WHERE id = $1", [lot.auction_id])).rows[0];
    return { bidId: String(inserted.rows[0].id), replayed: false, closeAt: new Date(after.close_at).toISOString(), extended: after.f === '1' };
  }

  /** What a customer may know about their own position on a lot. Never leaks a competitor's price or identity. */
  async myStatus(p: Principal, lotId: string) {
    return this.db.withPrincipal(p, async (c) => {
      const lot = (await c.query('SELECT id FROM auction_lots WHERE id = $1', [lotId])).rows[0];
      if (!lot) throw new BidRejected('LOT_NOT_FOUND', 'Lot not found.', 404);
      const st = (await c.query('SELECT leader_is_me FROM lot_price_state($1)', [lotId])).rows[0];
      const mine = (await c.query('SELECT max(amount)::text AS amount FROM bids WHERE lot_id = $1 AND customer_id = $2', [lotId, p.customerId])).rows[0];
      const visible = (await c.query('SELECT visible_highest_bid($1)::text AS v', [lotId])).rows[0].v;
      const status = !mine.amount ? 'no_bid' : st?.leader_is_me ? 'leading' : 'outbid';
      return { status, myHighestBid: mine.amount ?? null, currentHighestBid: visible ?? null };
    });
  }

  /**
   * The caller's position on every lot of an auction in one call (for the web app's lot table). The minimum next
   * bid is included only when it reveals nothing new: in 'full_price' auctions, or on lots the caller leads
   * (where the price is their own bid). It uses the caller's OWN margin bracket, exactly as the engine will.
   */
  async myPositions(p: Principal, auctionId: string) {
    return this.db.withPrincipal(p, async (c) => {
      const auction = (await c.query('SELECT id, status, bid_visibility FROM auctions WHERE id = $1', [auctionId])).rows[0];
      if (!auction) throw new BidRejected('AUCTION_NOT_FOUND', 'Auction not found.', 404);
      const lots = (await c.query(
        `SELECT l.id AS lot_id, l.status, l.starting_price::text AS starting_price, l.fallback_increment::text AS fallback,
                mb.amount AS my_highest_bid, coalesce(ps.leader_is_me, false) AS leader_is_me,
                visible_highest_bid(l.id)::text AS current_highest_bid
           FROM auction_lots l
           LEFT JOIN LATERAL (SELECT max(b.amount)::text AS amount FROM bids b WHERE b.lot_id = l.id AND b.customer_id = $2) mb ON true
           LEFT JOIN LATERAL lot_price_state(l.id) ps ON true
          WHERE l.auction_id = $1 ORDER BY l.lot_number`, [auctionId, p.customerId])).rows;
      const brackets = (await c.query(
        `SELECT b.price_from::text AS f, b.price_to::text AS t, b.margin::text AS m FROM margin_rule_brackets b
           JOIN customers cu ON cu.margin_rule_set_id = b.rule_set_id WHERE cu.id = $1`, [p.customerId])).rows
        .map((b) => ({ from: toCents(b.f), to: toCents(b.t), margin: toCents(b.m) }));
      const fullPrice = auction.bid_visibility === 'full_price';

      return lots.map((l) => {
        const status = !l.my_highest_bid ? 'no_bid' : l.leader_is_me ? 'leading' : 'outbid';
        const knownPrice: string | null = fullPrice ? l.current_highest_bid : status === 'leading' ? l.my_highest_bid : null;
        let minNextBid: string | null = null;
        if (l.status === 'active' && (fullPrice || status === 'leading')) {
          if (knownPrice === null) minNextBid = l.starting_price;
          else {
            const price = toCents(knownPrice);
            const br = brackets.find((b) => price >= b.from && price < b.to);
            minNextBid = fromCents(price + (br ? br.margin : toCents(l.fallback)));
          }
        }
        return {
          lotId: l.lot_id, lotStatus: l.status, status, myHighestBid: l.my_highest_bid ?? null,
          currentHighestBid: l.current_highest_bid ?? null, minNextBid,
        };
      });
    });
  }

  private async closeAt(c: PoolClient, auctionId: string): Promise<string> {
    const r = await c.query('SELECT close_at FROM auctions WHERE id = $1', [auctionId]);
    return new Date(r.rows[0].close_at).toISOString();
  }

  private async recordRejection(p: Principal, input: PlaceBidInput, err: BidRejected, ip?: string): Promise<void> {
    try {
      await this.db.withPrincipal(p, (c) =>
        this.audit.record(c, { actor: p, action: 'bid.rejected', referenceType: 'lot', referenceId: input.lotId, after: { code: err.code, amount: input.amount }, ip }));
    } catch (e) {
      this.logger.error('failed to audit bid rejection', e instanceof Error ? e.stack : String(e));
    }
  }
}
