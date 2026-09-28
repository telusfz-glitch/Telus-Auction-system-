-- 001_init: core tenancy model, row-level security (RLS), tamper-evident audit log.
-- Runs as the OWNER role. The API connects as `telus_app` (created by infra/postgres/init):
-- not owner, not superuser, NOBYPASSRLS → every policy below always applies to it.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telus_app') THEN
    RAISE EXCEPTION 'role telus_app must exist first (see infra/postgres/init/00-roles.sh)';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SEQUENCE IF NOT EXISTS customer_code_seq START 1;

-- ============ Tables ============
CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE DEFAULT ('CUST-' || lpad(nextval('customer_code_seq')::text, 4, '0')),
  company_name  text NOT NULL CHECK (length(company_name) BETWEEN 2 AND 200),
  contact_email text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','blocked','expired')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Child / team logins. Keycloak owns credentials; this row links a Keycloak subject to a customer.
CREATE TABLE customer_users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  keycloak_sub        text NOT NULL UNIQUE,
  display_name        text NOT NULL,
  role                text NOT NULL CHECK (role IN ('customer_admin','customer_bidder','customer_viewer')),
  can_access_external boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auctions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number     text NOT NULL UNIQUE,
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','live','closing','closed','under_review','finalized','archived','cancelled')),
  start_at   timestamptz NOT NULL,
  close_at   timestamptz NOT NULL,
  CHECK (close_at > start_at)
);

CREATE TABLE auction_participants (
  auction_id  uuid NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  is_allowed  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (auction_id, customer_id)
);

CREATE TABLE bids (
  id              bigserial PRIMARY KEY,
  auction_id      uuid NOT NULL REFERENCES auctions(id),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  acting_user_sub text NOT NULL,
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, idempotency_key)
);
CREATE INDEX bids_auction_idx ON bids (auction_id, amount DESC, created_at);

CREATE TABLE invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL UNIQUE,
  customer_id    uuid NOT NULL REFERENCES customers(id),
  total_amount   numeric(14,2) NOT NULL CHECK (total_amount >= 0),
  status         text NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','void')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id             bigserial PRIMARY KEY,
  actor_sub      text NOT NULL,
  actor_kind     text NOT NULL CHECK (actor_kind IN ('staff','customer','system')),
  action         text NOT NULL,
  reference_type text,
  reference_id   text,
  before_value   jsonb,
  after_value    jsonb,
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT now(),
  prev_hash      text,
  hash           text NOT NULL
);

-- ============ Session-context helpers (set per transaction by DbService.withPrincipal) ============
CREATE FUNCTION app_kind() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.role', true), '') $$;
CREATE FUNCTION app_customer_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.customer_id', true), '')::uuid $$;
CREATE FUNCTION app_customer_role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.customer_role', true), '') $$;
CREATE FUNCTION app_user_sub() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_sub', true), '') $$;
CREATE FUNCTION app_is_staff() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(app_kind() = 'staff', false) $$;

-- ============ Row-level security ============
-- With no context set, every helper returns NULL → no policy matches → zero rows (fail closed).
ALTER TABLE customers            ENABLE ROW LEVEL SECURITY; ALTER TABLE customers            FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_users       ENABLE ROW LEVEL SECURITY; ALTER TABLE customer_users       FORCE ROW LEVEL SECURITY;
ALTER TABLE auctions             ENABLE ROW LEVEL SECURITY; ALTER TABLE auctions             FORCE ROW LEVEL SECURITY;
ALTER TABLE auction_participants ENABLE ROW LEVEL SECURITY; ALTER TABLE auction_participants FORCE ROW LEVEL SECURITY;
ALTER TABLE bids                 ENABLE ROW LEVEL SECURITY; ALTER TABLE bids                 FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices             ENABLE ROW LEVEL SECURITY; ALTER TABLE invoices             FORCE ROW LEVEL SECURITY;
-- audit_logs: ENABLE only (not FORCE) so the SECURITY DEFINER chain trigger (owner) can read the last hash.
ALTER TABLE audit_logs           ENABLE ROW LEVEL SECURITY;

CREATE POLICY customers_staff ON customers FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY customers_self  ON customers FOR SELECT USING (id = app_customer_id());

CREATE POLICY cu_staff       ON customer_users FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY cu_self_read   ON customer_users FOR SELECT USING (customer_id = app_customer_id());
CREATE POLICY cu_admin_ins   ON customer_users FOR INSERT WITH CHECK (customer_id = app_customer_id() AND app_customer_role() = 'customer_admin');
CREATE POLICY cu_admin_upd   ON customer_users FOR UPDATE USING (customer_id = app_customer_id() AND app_customer_role() = 'customer_admin') WITH CHECK (customer_id = app_customer_id());
CREATE POLICY cu_admin_del   ON customer_users FOR DELETE USING (customer_id = app_customer_id() AND app_customer_role() = 'customer_admin');

CREATE POLICY auctions_staff ON auctions FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY auctions_participant_read ON auctions FOR SELECT USING (
  auctions.status <> 'draft' AND EXISTS (
    SELECT 1 FROM auction_participants ap
    WHERE ap.auction_id = auctions.id AND ap.customer_id = app_customer_id() AND ap.is_allowed));

CREATE POLICY ap_staff     ON auction_participants FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY ap_self_read ON auction_participants FOR SELECT USING (customer_id = app_customer_id());

CREATE POLICY bids_staff_read    ON bids FOR SELECT USING (app_is_staff());
CREATE POLICY bids_customer_read ON bids FOR SELECT USING (customer_id = app_customer_id());
-- A bid can only be inserted by a bidder/admin of that customer, as themselves, into an auction they were invited to.
CREATE POLICY bids_customer_insert ON bids FOR INSERT WITH CHECK (
  customer_id = app_customer_id()
  AND acting_user_sub = app_user_sub()
  AND app_customer_role() IN ('customer_admin','customer_bidder')
  AND EXISTS (SELECT 1 FROM auction_participants ap
              WHERE ap.auction_id = bids.auction_id AND ap.customer_id = bids.customer_id AND ap.is_allowed));

CREATE POLICY invoices_staff ON invoices FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY invoices_self  ON invoices FOR SELECT USING (customer_id = app_customer_id());

CREATE POLICY audit_staff_read ON audit_logs FOR SELECT USING (app_is_staff());
CREATE POLICY audit_insert     ON audit_logs FOR INSERT WITH CHECK (actor_sub = app_user_sub());

-- ============ Tamper-evident audit log: append-only + SHA-256 hash chain ============
CREATE FUNCTION audit_compute_hash(prev text, a audit_logs) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp AS $$
  SELECT encode(digest(
    coalesce(prev,'') || '|' || a.actor_sub || '|' || a.actor_kind || '|' || a.action || '|' ||
    coalesce(a.reference_type,'') || '|' || coalesce(a.reference_id,'') || '|' ||
    coalesce(a.before_value::text,'') || '|' || coalesce(a.after_value::text,'') || '|' ||
    to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'sha256'), 'hex')
$$;

CREATE FUNCTION audit_logs_chain() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE prev text;
BEGIN
  PERFORM pg_advisory_xact_lock(727001);  -- serialise inserts so the chain has a single order
  -- Assign the id INSIDE the lock. If the default (evaluated before this trigger) were kept, two concurrent
  -- writers could receive ids 13/14 but be chained in the opposite order, and verification (which walks by id)
  -- would report a false break. Gaps in ids are harmless; ordering is what matters.
  NEW.id := nextval(pg_get_serial_sequence('audit_logs', 'id'));
  SELECT hash INTO prev FROM audit_logs ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.hash := audit_compute_hash(prev, NEW);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_logs_chain_trg BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_chain();

CREATE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;
CREATE TRIGGER audit_logs_no_update   BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW       EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE          ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

-- Returns NULL when the chain is intact, otherwise the id of the first broken row.
CREATE FUNCTION verify_audit_chain() RETURNS bigint LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp AS $$
DECLARE r audit_logs; prev text := NULL;
BEGIN
  FOR r IN SELECT * FROM audit_logs ORDER BY id LOOP
    IF r.prev_hash IS DISTINCT FROM prev OR r.hash <> audit_compute_hash(prev, r) THEN RETURN r.id; END IF;
    prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION verify_audit_chain() FROM PUBLIC;

-- ============ Least-privilege grants for the runtime role ============
GRANT USAGE ON SCHEMA public TO telus_app;
GRANT SELECT, INSERT, UPDATE         ON customers, auctions, invoices          TO telus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_users, auction_participants   TO telus_app;
GRANT SELECT, INSERT                 ON bids, audit_logs                       TO telus_app;  -- no UPDATE/DELETE, ever
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO telus_app;
