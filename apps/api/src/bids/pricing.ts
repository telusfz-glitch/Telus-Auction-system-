import type { PoolClient } from 'pg';
import { toCents } from './money';

/** One margin bracket in cents: a price in [from, to) must be beaten by at least `margin`. */
export interface Bracket { from: bigint; to: bigint; margin: bigint }

/**
 * The margin brackets that apply to this customer in this auction, in cents: the copy frozen when the auction was
 * scheduled (or when the customer was invited to it later), so a rule change never alters a running auction
 * (migration 015). Only an auction without a frozen copy (never scheduled) falls back to the company's current rule set.
 */
export async function loadBrackets(c: PoolClient, customerId: string, auctionId: string): Promise<Bracket[]> {
  const frozen = (await c.query(
    'SELECT brackets FROM auction_customer_rules WHERE auction_id = $1 AND customer_id = $2', [auctionId, customerId])).rows[0];
  const rows: Array<{ f: string; t: string; m: string }> = frozen ? frozen.brackets : (await c.query(
    `SELECT b.price_from::text AS f, b.price_to::text AS t, b.margin::text AS m FROM margin_rule_brackets b
       JOIN customers cu ON cu.margin_rule_set_id = b.rule_set_id WHERE cu.id = $1`, [customerId])).rows;
  return rows.map((b) => ({ from: toCents(b.f), to: toCents(b.t), margin: toCents(b.m) }));
}

/**
 * The lowest acceptable next bid, in cents — THE pricing rule, used both by the bid engine (to accept or refuse) and
 * by the lot table (to show the customer what to bid), so the two can never disagree.
 * No bid yet → the starting price. Otherwise the current price plus the margin of the bracket containing it, or the
 * lot's fallback increment when no bracket covers that price.
 */
export function minNextBid(price: bigint | null, startingPrice: bigint, fallbackIncrement: bigint, brackets: readonly Bracket[]): bigint {
  if (price === null) return startingPrice;
  const br = brackets.find((b) => price >= b.from && price < b.to);
  return price + (br ? br.margin : fallbackIncrement);
}
