-- 008: email_enqueue_for_events without deadlocks between concurrent publishers.
-- Two publishers claim DIFFERENT outbox events (SKIP LOCKED), but different events can map to the same email (e.g. one
-- outbid notice per company/lot/10-minute window). Inserting those keys in event order let two transactions take the
-- unique-index locks in opposite orders and deadlock (seen in the concurrent-publisher test). Now every candidate email
-- of a batch is inserted by ONE statement in dedupe-key order, so concurrent publishers always lock keys in the same
-- order: they may wait for each other, never deadlock.
CREATE OR REPLACE FUNCTION email_enqueue_for_events(p_ids bigint[]) RETURNS int LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  PERFORM require_system();
  WITH ev AS (
    SELECT id, type, payload, created_at FROM outbox_events WHERE id = ANY (p_ids)
  ), cand AS (
    -- At most one outbid email per customer, per lot, per 10 minutes: a bidding war must not become a mail flood.
    SELECT ev.id AS event_id, 'lot.outbid' AS kind, (ev.payload->>'previousLeaderCustomerId')::uuid AS customer_id,
           (ev.payload->>'auctionId')::uuid AS auction_id,
           format('outbid:%s:%s:%s', ev.payload->>'previousLeaderCustomerId', ev.payload->>'lotId',
                  floor(extract(epoch FROM ev.created_at) / 600)) AS dedupe_key,
           jsonb_build_object('lotId', ev.payload->'lotId',
                              'highestBid', CASE WHEN ev.payload->>'visibility' = 'full_price' THEN ev.payload->'amount' END) AS payload
      FROM ev
     WHERE ev.type = 'bid.accepted' AND (ev.payload->>'previousLeaderCustomerId') IS NOT NULL
       AND ev.payload->>'previousLeaderCustomerId' <> ev.payload->>'leaderCustomerId'
    UNION ALL
    SELECT ev.id, 'auction.won', r.winner_customer_id, r.auction_id, format('won:%s:%s', r.auction_id, r.winner_customer_id), '{}'::jsonb
      FROM ev JOIN lot_results r ON r.auction_id = (ev.payload->>'auctionId')::uuid AND r.outcome = 'won'
     WHERE ev.type = 'auction.closed'
    UNION ALL
    SELECT ev.id, 'auction.cancelled', ap.customer_id, ap.auction_id, format('cancelled:%s:%s', ap.auction_id, ap.customer_id), '{}'::jsonb
      FROM ev JOIN auction_participants ap ON ap.auction_id = (ev.payload->>'auctionId')::uuid AND ap.is_allowed
     WHERE ev.type = 'auction.cancelled' AND (ev.payload->>'previousStatus') <> 'draft'   -- drafts were never visible to customers
    UNION ALL
    SELECT ev.id, 'invoice.issued', (ev.payload->>'customerId')::uuid, (ev.payload->>'auctionId')::uuid,
           format('invoice:%s', ev.payload->>'invoiceId'), jsonb_build_object('invoiceId', ev.payload->'invoiceId')
      FROM ev WHERE ev.type = 'invoice.issued'
  ), one AS (
    SELECT DISTINCT ON (dedupe_key) kind, customer_id, auction_id, dedupe_key, payload
      FROM cand ORDER BY dedupe_key, event_id
  )
  INSERT INTO email_queue (kind, customer_id, auction_id, dedupe_key, payload)
  SELECT kind, customer_id, auction_id, dedupe_key, payload FROM one ORDER BY dedupe_key
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
