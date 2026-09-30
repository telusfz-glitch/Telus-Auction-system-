-- The customer lot table for a whole auction in one pass (performance, docs/AUDIT.md P4). Until now it called
-- lot_price_state() and visible_highest_bid() once per lot: ~70 ms of a ~90 ms query at 1,000 lots.
-- Same rules as those two functions, which stay for single-lot use:
--   - nothing at all unless the caller's company is an allowed participant of the auction;
--   - leader_is_me for every lot with bids;
--   - the price only when the auction's visibility is 'full_price'.
CREATE INDEX IF NOT EXISTS lot_bid_state_auction_idx ON lot_bid_state (auction_id);

CREATE FUNCTION auction_lot_positions(p_auction uuid)
RETURNS TABLE (lot_id uuid, visible_highest numeric, leader_is_me boolean) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT s.lot_id,
         CASE WHEN a.bid_visibility = 'full_price' THEN s.highest_amount END,
         s.leader_customer_id = app_customer_id()
    FROM lot_bid_state s JOIN auctions a ON a.id = s.auction_id
   WHERE s.auction_id = p_auction
     AND EXISTS (SELECT 1 FROM auction_participants ap
                  WHERE ap.auction_id = p_auction AND ap.customer_id = app_customer_id() AND ap.is_allowed)
$$;
