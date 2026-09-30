-- Margin brackets are frozen per auction (owner's decision, 30 Sep 2026): the brackets each participant's company has
-- when the auction is SCHEDULED are the ones that auction uses until it ends. Changing a rule set, or a customer's
-- assigned rule set, affects only auctions scheduled afterwards. A company invited later (to a scheduled or live
-- auction) is frozen at the moment of its invitation. Unscheduling (back to draft) drops the copy; scheduling again
-- takes a fresh one.

CREATE TABLE auction_customer_rules (
  auction_id  uuid NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  -- [{"f": price_from, "t": price_to, "m": margin}, ...] as exact decimal strings; [] = no rule set (lot increment applies)
  brackets    jsonb NOT NULL,
  frozen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (auction_id, customer_id)
);
-- No FORCE: written only by the owner-run functions below. The API role may only read.
ALTER TABLE auction_customer_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY acr_staff_read ON auction_customer_rules FOR SELECT USING (app_is_staff());
CREATE POLICY acr_self_read  ON auction_customer_rules FOR SELECT USING (customer_id = app_customer_id());
GRANT SELECT ON auction_customer_rules TO telus_app;

-- Copies one company's current brackets into one auction; keeps an existing copy (frozen means frozen).
-- Runs as the owner, but only when a STAFF member schedules or invites: customers and brackets are FORCE'd-RLS tables,
-- readable here only through the staff policies, so any other caller would freeze an empty set — refused instead.
CREATE FUNCTION freeze_auction_rules(p_auction uuid, p_customer uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_staff() THEN RAISE EXCEPTION 'FREEZE_REQUIRES_STAFF' USING ERRCODE = '42501'; END IF;
  INSERT INTO auction_customer_rules (auction_id, customer_id, brackets)
  SELECT p_auction, c.id, coalesce((
           SELECT jsonb_agg(jsonb_build_object('f', b.price_from::text, 't', b.price_to::text, 'm', b.margin::text) ORDER BY b.price_from)
             FROM margin_rule_brackets b WHERE b.rule_set_id = c.margin_rule_set_id), '[]'::jsonb)
    FROM customers c WHERE c.id = p_customer
  ON CONFLICT (auction_id, customer_id) DO NOTHING;
END $$;
REVOKE EXECUTE ON FUNCTION freeze_auction_rules(uuid, uuid) FROM PUBLIC;

CREATE FUNCTION auctions_freeze_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'scheduled' THEN
    DELETE FROM auction_customer_rules WHERE auction_id = NEW.id;
    FOR r IN SELECT customer_id FROM auction_participants WHERE auction_id = NEW.id AND is_allowed LOOP
      PERFORM freeze_auction_rules(NEW.id, r.customer_id);
    END LOOP;
  ELSIF OLD.status = 'scheduled' AND NEW.status = 'draft' THEN
    DELETE FROM auction_customer_rules WHERE auction_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER auctions_freeze_rules_trg AFTER UPDATE OF status ON auctions
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION auctions_freeze_rules();

CREATE FUNCTION participants_freeze_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.is_allowed AND (SELECT status FROM auctions WHERE id = NEW.auction_id) NOT IN ('draft', 'cancelled') THEN
    PERFORM freeze_auction_rules(NEW.auction_id, NEW.customer_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER participants_freeze_rules_trg AFTER INSERT OR UPDATE OF is_allowed ON auction_participants
  FOR EACH ROW EXECUTE FUNCTION participants_freeze_rules();

-- Auctions already scheduled or running when this migration is applied: freeze them now, with today's brackets.
-- (Migrations run as the owner with no RLS identity; act as staff for the duration of this transaction.)
SELECT set_config('app.role', 'staff', true), set_config('app.user_sub', 'migration-015', true);
SELECT freeze_auction_rules(ap.auction_id, ap.customer_id)
  FROM auction_participants ap JOIN auctions a ON a.id = ap.auction_id
 WHERE ap.is_allowed AND a.status IN ('scheduled', 'live', 'closing');
