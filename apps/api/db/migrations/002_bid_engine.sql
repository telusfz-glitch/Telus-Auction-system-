-- 002_bid_engine: lots, margin rules, limits, security settings, and the DB-level bid invariants.
-- Design: the application engine (src/bids) does the business validation and friendly errors; the
-- trigger below is the SAFETY NET that makes it impossible — even for buggy code — to record a bid
-- on a closed auction, a bid that is not strictly higher, or to lose an update under concurrency.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------- auction settings ----------
ALTER TABLE auctions
  ADD COLUMN bid_visibility text NOT NULL DEFAULT 'winning_losing_only'
      CHECK (bid_visibility IN ('full_price','winning_losing_only','rank_no_identity','own_bid_only')),
  ADD COLUMN extension_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN extension_window_seconds int NOT NULL DEFAULT 120 CHECK (extension_window_seconds > 0),
  ADD COLUMN extension_seconds int NOT NULL DEFAULT 120 CHECK (extension_seconds > 0);
-- The bid trigger (owner-run SECURITY DEFINER) must extend close_at. The runtime role is never the owner,
-- so it stays fully subject to RLS; FORCE only mattered for the owner, which the API never connects as.
ALTER TABLE auctions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE auction_participants ADD COLUMN terms_accepted_at timestamptz;

-- ---------- margin rules (bracketed minimum increments) ----------
CREATE TABLE margin_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE margin_rule_brackets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id uuid NOT NULL REFERENCES margin_rule_sets(id) ON DELETE CASCADE,
  price_from numeric(14,2) NOT NULL CHECK (price_from >= 0),
  price_to   numeric(14,2) NOT NULL,
  margin     numeric(14,2) NOT NULL CHECK (margin > 0),
  CHECK (price_to > price_from),
  -- The database itself guarantees brackets in one set never overlap.
  CONSTRAINT brackets_no_overlap EXCLUDE USING gist (rule_set_id WITH =, numrange(price_from, price_to, '[)') WITH &&)
);
ALTER TABLE customers ADD COLUMN margin_rule_set_id uuid REFERENCES margin_rule_sets(id);

-- ---------- limits & platform security settings ----------
CREATE TABLE customer_limits (
  customer_id uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  max_purchase_value numeric(14,2) NOT NULL DEFAULT 0 CHECK (max_purchase_value >= 0)   -- 0 = no capacity assigned = cannot bid
);
CREATE TABLE security_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),                                        -- single-row table
  max_bid_limit numeric(14,2) NOT NULL DEFAULT 1000000 CHECK (max_bid_limit > 0),         -- HARD cap: nobody may bid above this
  range_enabled boolean NOT NULL DEFAULT false,
  range_min numeric(14,2) NOT NULL DEFAULT 0 CHECK (range_min >= 0),
  range_max numeric(14,2) NOT NULL DEFAULT 1000000000,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (range_max > range_min)
);
INSERT INTO security_settings DEFAULT VALUES;

-- ---------- lots ----------
CREATE TABLE auction_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id uuid NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  lot_number text NOT NULL,
  description text NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0),
  starting_price numeric(14,2) NOT NULL CHECK (starting_price > 0),
  fallback_increment numeric(14,2) NOT NULL DEFAULT 25 CHECK (fallback_increment > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  UNIQUE (auction_id, lot_number),
  UNIQUE (id, auction_id)
);

-- bids now belong to a lot; (lot_id, auction_id) must agree, enforced by a composite FK.
ALTER TABLE bids
  ADD COLUMN lot_id uuid NOT NULL,
  ADD COLUMN request_hash text NOT NULL DEFAULT '',
  ADD COLUMN ip inet;
ALTER TABLE bids ADD CONSTRAINT bids_lot_fk FOREIGN KEY (lot_id, auction_id) REFERENCES auction_lots(id, auction_id);
CREATE INDEX bids_lot_idx ON bids (lot_id, amount DESC);

-- Current price/leader per lot. Written ONLY by the bid trigger; customers can read only rows they lead
-- (so nobody can learn a competitor's price or identity from this table).
CREATE TABLE lot_bid_state (
  lot_id uuid PRIMARY KEY REFERENCES auction_lots(id) ON DELETE CASCADE,
  auction_id uuid NOT NULL,
  highest_amount numeric(14,2) NOT NULL,
  leader_customer_id uuid NOT NULL REFERENCES customers(id),
  bid_count int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Transactional outbox: realtime/notification publishers read this later; written in the same transaction as the bid.
CREATE TABLE outbox_events (
  id bigserial PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

-- ---------- RLS ----------
ALTER TABLE margin_rule_sets     ENABLE ROW LEVEL SECURITY; ALTER TABLE margin_rule_sets     FORCE ROW LEVEL SECURITY;
ALTER TABLE margin_rule_brackets ENABLE ROW LEVEL SECURITY; ALTER TABLE margin_rule_brackets FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_limits      ENABLE ROW LEVEL SECURITY; ALTER TABLE customer_limits      FORCE ROW LEVEL SECURITY;
ALTER TABLE security_settings    ENABLE ROW LEVEL SECURITY; ALTER TABLE security_settings    FORCE ROW LEVEL SECURITY;
ALTER TABLE auction_lots         ENABLE ROW LEVEL SECURITY; ALTER TABLE auction_lots         FORCE ROW LEVEL SECURITY;
ALTER TABLE lot_bid_state        ENABLE ROW LEVEL SECURITY;   -- no FORCE: written by the owner-run trigger
ALTER TABLE outbox_events        ENABLE ROW LEVEL SECURITY;   -- no FORCE: written by the owner-run trigger

CREATE POLICY mrs_staff ON margin_rule_sets FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY mrs_own   ON margin_rule_sets FOR SELECT USING (id = (SELECT margin_rule_set_id FROM customers WHERE id = app_customer_id()));
CREATE POLICY mrb_staff ON margin_rule_brackets FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY mrb_own   ON margin_rule_brackets FOR SELECT USING (rule_set_id = (SELECT margin_rule_set_id FROM customers WHERE id = app_customer_id()));
CREATE POLICY cl_staff  ON customer_limits FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY cl_self   ON customer_limits FOR SELECT USING (customer_id = app_customer_id());
CREATE POLICY sec_read  ON security_settings FOR SELECT USING (app_kind() IN ('staff','customer'));
CREATE POLICY sec_staff_update ON security_settings FOR UPDATE USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY lots_staff ON auction_lots FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
-- Nested RLS: a customer sees a lot only if RLS already lets them see its auction (invited + not draft).
CREATE POLICY lots_participant_read ON auction_lots FOR SELECT USING (auction_id IN (SELECT id FROM auctions));
CREATE POLICY lbs_staff_read  ON lot_bid_state FOR SELECT USING (app_is_staff());
CREATE POLICY lbs_leader_read ON lot_bid_state FOR SELECT USING (leader_customer_id = app_customer_id());
CREATE POLICY outbox_staff_read ON outbox_events FOR SELECT USING (app_is_staff());

-- ---------- the bid safety net ----------
CREATE FUNCTION bids_guard_and_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  a auctions%ROWTYPE;
  s lot_bid_state%ROWTYPE;
  now_ts timestamptz := clock_timestamp();
  new_close timestamptz;
  did_extend boolean;
BEGIN
  -- Per-lot serialisation (same key the engine uses; advisory locks are re-entrant within a session).
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.lot_id::text, 0));

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
    'bidId', NEW.id, 'lotId', NEW.lot_id, 'auctionId', NEW.auction_id, 'amount', NEW.amount,
    'leaderCustomerId', NEW.customer_id, 'previousLeaderCustomerId', s.leader_customer_id,
    'closeAt', new_close, 'extended', did_extend));

  PERFORM set_config('app.last_bid_extended', CASE WHEN did_extend THEN '1' ELSE '0' END, true);
  RETURN NEW;
END $$;
CREATE TRIGGER bids_guard_apply BEFORE INSERT ON bids FOR EACH ROW EXECUTE FUNCTION bids_guard_and_apply();

-- Narrow, audited disclosure paths (SECURITY DEFINER) so the API never needs broad read access to lot_bid_state.
CREATE FUNCTION lot_price_state(p_lot uuid)
RETURNS TABLE (highest_amount numeric, bid_count int, leader_is_me boolean) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT s.highest_amount, s.bid_count, (s.leader_customer_id = app_customer_id())
  FROM lot_bid_state s
  WHERE s.lot_id = p_lot AND EXISTS (SELECT 1 FROM auction_participants ap
        WHERE ap.auction_id = s.auction_id AND ap.customer_id = app_customer_id() AND ap.is_allowed)
$$;

-- The ONLY way a customer can learn the current price: returns it iff the auction's visibility mode is 'full_price'.
CREATE FUNCTION visible_highest_bid(p_lot uuid) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT s.highest_amount FROM lot_bid_state s JOIN auctions a ON a.id = s.auction_id
  WHERE s.lot_id = p_lot AND a.bid_visibility = 'full_price'
    AND EXISTS (SELECT 1 FROM auction_participants ap
        WHERE ap.auction_id = s.auction_id AND ap.customer_id = app_customer_id() AND ap.is_allowed)
$$;

-- ---------- grants ----------
GRANT SELECT, INSERT, UPDATE, DELETE ON margin_rule_sets, margin_rule_brackets, auction_lots, customer_limits TO telus_app;
GRANT SELECT, UPDATE ON security_settings TO telus_app;
GRANT SELECT ON lot_bid_state, outbox_events TO telus_app;   -- read-only: state changes only via the bid trigger
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO telus_app;
