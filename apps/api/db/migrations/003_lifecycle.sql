-- 003_lifecycle: auctions open and close themselves, lots are allocated at close, staff finalise into invoices,
-- and the outbox gets a safe claim/publish protocol. Also lets a customer accept an auction's terms.
--
-- Closing is the delicate part. A bid that passed the "is it open?" check a microsecond before close_at must not
-- commit AFTER the allocation was computed, or the recorded winner would be wrong. So every bid takes a SHARED
-- advisory lock on its auction (inside the bid trigger) and the closer takes the same lock EXCLUSIVELY: the closer
-- waits for in-flight bids to commit, and bids arriving later queue behind it and then see status = 'closed'.
-- Lock order is customer → lot → auction(shared) → auction row for bids, and auction(exclusive) → auction row for
-- the closer, so no wait-for cycle is possible.

CREATE FUNCTION app_is_system() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(app_kind() = 'system', false) $$;
CREATE FUNCTION auction_lock_key(p_auction uuid) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT hashtextextended('auction:' || p_auction::text, 0) $$;

-- The background worker runs with app.role = 'system'. It never reads these tables directly: it only calls the
-- SECURITY DEFINER functions below, which run as the owner and are subject to these FORCE'd tables' policies.
CREATE POLICY lots_system_read ON auction_lots FOR SELECT USING (app_is_system());
CREATE POLICY bids_system_read ON bids FOR SELECT USING (app_is_system());

-- ---------- bid trigger: + shared auction lock; outbox payload gains the visibility mode, amount becomes text ----------
CREATE OR REPLACE FUNCTION bids_guard_and_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  a auctions%ROWTYPE;
  s lot_bid_state%ROWTYPE;
  now_ts timestamptz;
  new_close timestamptz;
  did_extend boolean;
BEGIN
  -- Per-lot serialisation (same key the engine uses; advisory locks are re-entrant within a session).
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.lot_id::text, 0));
  -- Shared with other bids on this auction, exclusive with the closer (see header).
  PERFORM pg_advisory_xact_lock_shared(auction_lock_key(NEW.auction_id));
  now_ts := clock_timestamp();

  SELECT * INTO a FROM auctions WHERE id = NEW.auction_id;
  IF NOT FOUND OR a.status <> 'live' OR now_ts < a.start_at OR now_ts >= a.close_at THEN
    RAISE EXCEPTION 'AUCTION_NOT_OPEN' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO s FROM lot_bid_state WHERE lot_id = NEW.lot_id;
  IF FOUND AND NEW.amount <= s.highest_amount THEN
    RAISE EXCEPTION 'BID_NOT_HIGHER' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO lot_bid_state (lot_id, auction_id, highest_amount, leader_customer_id, bid_count, updated_at)
  VALUES (NEW.lot_id, NEW.auction_id, NEW.amount, NEW.customer_id, 1, now_ts)
  ON CONFLICT (lot_id) DO UPDATE SET
    highest_amount = EXCLUDED.highest_amount, leader_customer_id = EXCLUDED.leader_customer_id,
    bid_count = lot_bid_state.bid_count + 1, updated_at = EXCLUDED.updated_at;

  -- Anti-sniping, atomically. Under READ COMMITTED the WHERE is re-checked against the latest row after
  -- any lock wait, so two simultaneous late bids extend the auction ONCE, not twice.
  UPDATE auctions SET close_at = close_at + make_interval(secs => extension_seconds)
   WHERE id = a.id AND extension_enabled AND close_at - now_ts <= make_interval(secs => extension_window_seconds)
  RETURNING close_at INTO new_close;
  did_extend := FOUND;
  IF NOT did_extend THEN SELECT close_at INTO new_close FROM auctions WHERE id = a.id; END IF;

  INSERT INTO outbox_events (type, payload) VALUES ('bid.accepted', jsonb_build_object(
    'bidId', NEW.id, 'lotId', NEW.lot_id, 'auctionId', NEW.auction_id, 'amount', NEW.amount::text,   -- text, not a JSON number: money never goes through floats
    'leaderCustomerId', NEW.customer_id, 'previousLeaderCustomerId', s.leader_customer_id,
    'closeAt', new_close, 'extended', did_extend, 'visibility', a.bid_visibility));

  PERFORM set_config('app.last_bid_extended', CASE WHEN did_extend THEN '1' ELSE '0' END, true);
  RETURN NEW;
END $$;

-- ---------- allocation ----------
-- One row per lot, written once, at close, by close_auction_if_due(). Winner = the lot's leader at close.
CREATE TABLE lot_results (
  lot_id             uuid PRIMARY KEY REFERENCES auction_lots(id),
  auction_id         uuid NOT NULL REFERENCES auctions(id),
  outcome            text NOT NULL CHECK (outcome IN ('won','unsold','withdrawn')),
  winner_customer_id uuid REFERENCES customers(id),
  winning_bid_id     bigint REFERENCES bids(id),
  unit_price         numeric(14,2),
  quantity           int NOT NULL CHECK (quantity > 0),
  total              numeric(14,2),
  decided_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'won') = (winner_customer_id IS NOT NULL AND winning_bid_id IS NOT NULL AND unit_price IS NOT NULL AND total IS NOT NULL))
);
CREATE INDEX lot_results_auction_idx ON lot_results (auction_id);
CREATE INDEX lot_results_winner_idx ON lot_results (winner_customer_id) WHERE winner_customer_id IS NOT NULL;
ALTER TABLE lot_results ENABLE ROW LEVEL SECURITY;   -- no FORCE: written only by the owner-run closer
CREATE POLICY lr_staff_read  ON lot_results FOR SELECT USING (app_is_staff());
CREATE POLICY lr_winner_read ON lot_results FOR SELECT USING (winner_customer_id = app_customer_id());
CREATE FUNCTION forbid_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER lot_results_no_update BEFORE UPDATE OR DELETE ON lot_results FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- ---------- scheduler entry points (callable only with app.role = 'system') ----------
CREATE FUNCTION require_system() RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT app_is_system() THEN RAISE EXCEPTION 'SYSTEM_CONTEXT_REQUIRED' USING ERRCODE = '42501'; END IF;
END $$;

CREATE FUNCTION open_due_auctions() RETURNS SETOF uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  PERFORM require_system();
  -- Row locks make this idempotent under concurrent workers: the loser re-checks status after the wait and skips.
  FOR r IN UPDATE auctions SET status = 'live' WHERE status = 'scheduled' AND start_at <= clock_timestamp()
           RETURNING id, close_at LOOP
    INSERT INTO outbox_events (type, payload) VALUES ('auction.opened',
      jsonb_build_object('auctionId', r.id, 'status', 'live', 'closeAt', r.close_at));
    RETURN NEXT r.id;
  END LOOP;
END $$;

CREATE FUNCTION due_auction_closures() RETURNS SETOF uuid LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT id FROM auctions WHERE app_is_system() AND status = 'live' AND close_at <= clock_timestamp() ORDER BY close_at
$$;

-- Closes ONE auction if (and only if) it is live and past close_at, and allocates its lots. Returns false when
-- there was nothing to do (not due any more because a late bid extended it, or another worker already closed it).
CREATE FUNCTION close_auction_if_due(p_auction uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE won int; unsold int;
BEGIN
  PERFORM require_system();
  -- Waits for every in-flight bid on this auction to commit; later bids queue behind us.
  PERFORM pg_advisory_xact_lock(auction_lock_key(p_auction));
  -- New statement ⇒ new snapshot: we see every bid (and extension) that committed while we waited.
  UPDATE auctions SET status = 'closed' WHERE id = p_auction AND status = 'live' AND close_at <= clock_timestamp();
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO lot_results (lot_id, auction_id, outcome, winner_customer_id, winning_bid_id, unit_price, quantity, total)
  SELECT l.id, l.auction_id,
         CASE WHEN l.status = 'withdrawn' THEN 'withdrawn' WHEN s.lot_id IS NULL THEN 'unsold' ELSE 'won' END,
         CASE WHEN l.status = 'active' THEN s.leader_customer_id END,
         CASE WHEN l.status = 'active' THEN wb.id END,
         CASE WHEN l.status = 'active' THEN s.highest_amount END,
         l.quantity,
         CASE WHEN l.status = 'active' THEN s.highest_amount * l.quantity END
    FROM auction_lots l
    LEFT JOIN lot_bid_state s ON s.lot_id = l.id
    LEFT JOIN LATERAL (SELECT b.id FROM bids b WHERE b.lot_id = l.id AND b.customer_id = s.leader_customer_id
                        AND b.amount = s.highest_amount ORDER BY b.id LIMIT 1) wb ON true
   WHERE l.auction_id = p_auction;

  SELECT count(*) FILTER (WHERE outcome = 'won'), count(*) FILTER (WHERE outcome <> 'won') INTO won, unsold
    FROM lot_results WHERE auction_id = p_auction;
  INSERT INTO outbox_events (type, payload) VALUES ('auction.closed',
    jsonb_build_object('auctionId', p_auction, 'status', 'closed', 'lotsWon', won, 'lotsUnsold', unsold));
  RETURN true;
END $$;

-- ---------- outbox: at-least-once delivery ----------
-- The publisher claims rows (row-locked, SKIP LOCKED so parallel publishers never double-send), delivers them,
-- then marks them published in the SAME transaction. A crash mid-delivery rolls back ⇒ the rows are re-delivered.
CREATE INDEX outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;

CREATE FUNCTION outbox_claim(p_limit int) RETURNS SETOF outbox_events LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM require_system();
  RETURN QUERY SELECT * FROM outbox_events WHERE published_at IS NULL ORDER BY id
                LIMIT least(greatest(p_limit, 1), 1000) FOR UPDATE SKIP LOCKED;
END $$;

CREATE FUNCTION outbox_mark_published(p_ids bigint[]) RETURNS int LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  PERFORM require_system();
  UPDATE outbox_events SET published_at = clock_timestamp() WHERE id = ANY (p_ids) AND published_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------- finalisation → invoices ----------
ALTER TABLE invoices ADD COLUMN auction_id uuid REFERENCES auctions(id);
ALTER TABLE invoices ADD CONSTRAINT invoices_one_per_auction_customer UNIQUE (auction_id, customer_id);

CREATE TABLE invoice_lines (
  id         bigserial PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  lot_id     uuid NOT NULL UNIQUE REFERENCES lot_results(lot_id),   -- a lot can be invoiced at most once, ever
  quantity   int NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,2) NOT NULL CHECK (unit_price > 0),
  amount     numeric(14,2) NOT NULL CHECK (amount > 0)
);
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY; ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY il_staff ON invoice_lines FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY il_self  ON invoice_lines FOR SELECT USING (invoice_id IN (SELECT id FROM invoices));   -- nested RLS on invoices

-- ---------- a customer accepting an auction's terms ----------
-- Customers may UPDATE their own participation row, but a guard trigger lets them change ONLY terms_accepted_at,
-- only from NULL (the first acceptance is the record), so even raw SQL cannot un-accept or self-invite.
CREATE POLICY ap_self_accept ON auction_participants FOR UPDATE
  USING (customer_id = app_customer_id() AND is_allowed AND app_customer_role() IN ('customer_admin','customer_bidder'))
  WITH CHECK (customer_id = app_customer_id());
CREATE FUNCTION auction_participants_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_is_staff() AND (
       NEW.auction_id IS DISTINCT FROM OLD.auction_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.is_allowed IS DISTINCT FROM OLD.is_allowed
    OR (OLD.terms_accepted_at IS NOT NULL AND NEW.terms_accepted_at IS DISTINCT FROM OLD.terms_accepted_at)
    OR NEW.terms_accepted_at IS NULL) THEN
    RAISE EXCEPTION 'PARTICIPANT_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auction_participants_guard_trg BEFORE UPDATE ON auction_participants FOR EACH ROW EXECUTE FUNCTION auction_participants_guard();

-- ---------- grants ----------
GRANT SELECT ON lot_results TO telus_app;                       -- read-only: written only by the closer
GRANT SELECT, INSERT ON invoice_lines TO telus_app;             -- no UPDATE/DELETE: invoices are corrected by voiding
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO telus_app;
REVOKE EXECUTE ON FUNCTION open_due_auctions(), due_auction_closures(), close_auction_if_due(uuid),
  outbox_claim(int), outbox_mark_published(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_due_auctions(), due_auction_closures(), close_auction_if_due(uuid),
  outbox_claim(int), outbox_mark_published(bigint[]) TO telus_app;
