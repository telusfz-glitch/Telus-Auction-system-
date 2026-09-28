-- 004_admin: database guards for the staff admin API, cancellation notices, outbox retention.
-- The admin endpoints (src/admin) check all of this too and return friendly errors; these triggers are the
-- safety net that holds even if application code is wrong.

-- ---------- a withdrawn lot can never receive a bid ----------
-- Fires before bids_guard_apply (triggers run in name order). It takes the same per-lot lock the engine and the
-- withdraw endpoint take, so a withdrawal and a bid on the same lot are strictly ordered.
CREATE FUNCTION bids_lot_active() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.lot_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM auction_lots WHERE id = NEW.lot_id AND status = 'active') THEN
    RAISE EXCEPTION 'LOT_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bids_a_lot_active BEFORE INSERT ON bids FOR EACH ROW EXECUTE FUNCTION bids_lot_active();

-- ---------- what staff may change on an auction, by status ----------
-- Only staff-context updates are checked: the bid trigger (anti-sniping) and the scheduler run in other contexts.
-- Staff can never set 'live' or 'closed' (only the scheduler can), and once an auction has started its timing,
-- visibility and identity are frozen, except that close_at may be pushed later while it is live.
CREATE FUNCTION auctions_staff_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean;
BEGIN
  IF NOT app_is_staff() THEN RETURN NEW; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := (OLD.status, NEW.status) IN (
      ('draft','scheduled'), ('scheduled','draft'),
      ('draft','cancelled'), ('scheduled','cancelled'), ('live','cancelled'),
      ('closed','under_review'), ('closed','finalized'), ('under_review','finalized'),
      ('finalized','archived'), ('cancelled','archived'));
    IF NOT allowed THEN
      RAISE EXCEPTION 'AUCTION_TRANSITION_FORBIDDEN: % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
    END IF;
  END IF;
  IF OLD.status NOT IN ('draft','scheduled') AND (
       NEW.id IS DISTINCT FROM OLD.id OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.start_at IS DISTINCT FROM OLD.start_at OR NEW.bid_visibility IS DISTINCT FROM OLD.bid_visibility
    OR NEW.extension_enabled IS DISTINCT FROM OLD.extension_enabled
    OR NEW.extension_window_seconds IS DISTINCT FROM OLD.extension_window_seconds
    OR NEW.extension_seconds IS DISTINCT FROM OLD.extension_seconds
    OR (NEW.close_at IS DISTINCT FROM OLD.close_at AND NOT (OLD.status = 'live' AND NEW.close_at > OLD.close_at))) THEN
    RAISE EXCEPTION 'AUCTION_FROZEN' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auctions_staff_guard_trg BEFORE UPDATE ON auctions FOR EACH ROW EXECUTE FUNCTION auctions_staff_guard();

-- Lots are editable while their auction is draft/scheduled. After that the only change is active → withdrawn.
CREATE FUNCTION auction_lots_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM auctions WHERE id = OLD.auction_id;
  IF TG_OP = 'DELETE' THEN
    IF st NOT IN ('draft','scheduled') THEN RAISE EXCEPTION 'LOT_FROZEN' USING ERRCODE = '42501'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.auction_id IS DISTINCT FROM OLD.auction_id THEN RAISE EXCEPTION 'LOT_FROZEN' USING ERRCODE = '42501'; END IF;
  IF st NOT IN ('draft','scheduled') AND (
       (NEW.status, NEW.lot_number, NEW.description, NEW.quantity, NEW.starting_price, NEW.fallback_increment)
       IS DISTINCT FROM ('withdrawn', OLD.lot_number, OLD.description, OLD.quantity, OLD.starting_price, OLD.fallback_increment)
    OR st NOT IN ('live')) THEN
    RAISE EXCEPTION 'LOT_FROZEN' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auction_lots_guard_trg BEFORE UPDATE OR DELETE ON auction_lots FOR EACH ROW EXECUTE FUNCTION auction_lots_guard();

-- ---------- tell participants when an auction is cancelled ----------
CREATE FUNCTION auctions_notify_cancel() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO outbox_events (type, payload) VALUES ('auction.cancelled',
    jsonb_build_object('auctionId', NEW.id, 'status', 'cancelled', 'previousStatus', OLD.status));
  RETURN NULL;
END $$;
CREATE TRIGGER auctions_notify_cancel_trg AFTER UPDATE OF status ON auctions FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled') EXECUTE FUNCTION auctions_notify_cancel();

-- ---------- outbox retention ----------
CREATE FUNCTION outbox_purge(p_older_than interval) RETURNS int LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  PERFORM require_system();
  IF p_older_than < interval '1 hour' THEN RAISE EXCEPTION 'retention too short'; END IF;
  DELETE FROM outbox_events WHERE published_at IS NOT NULL AND published_at < clock_timestamp() - p_older_than;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION outbox_purge(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_purge(interval) TO telus_app;
