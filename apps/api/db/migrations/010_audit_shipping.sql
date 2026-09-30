-- 010_audit_shipping: copy the hash-chained audit log, in batches, to write-once storage (S3 Object Lock, COMPLIANCE mode).
-- The in-database chain stops tampering by the application and by anyone who does not drop the triggers; the shipped copy
-- stops the rest: once a batch is locked, nobody (not the database owner, not the bucket owner) can change or delete it
-- before its retention date, and `npm run audit:verify` compares the database against it.
--
-- Ordering: audit inserts hold advisory lock 727001 until commit (001_init), so ids become visible strictly in order and
-- "everything after the last shipped id" never skips a row. Ids may have gaps (rolled-back inserts); continuity is proven
-- by prev_hash, not by ids.

CREATE TABLE audit_shipments (
  id           bigserial PRIMARY KEY,
  first_id     bigint NOT NULL,
  last_id      bigint NOT NULL,
  row_count    int NOT NULL CHECK (row_count > 0),
  first_prev_hash text,                          -- prev_hash of the batch's first row = last_hash of the previous batch
  last_hash    text NOT NULL,
  object_key   text NOT NULL UNIQUE,
  sha256       text NOT NULL,                    -- of the object's bytes
  retain_until timestamptz NOT NULL,
  shipped_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (first_id <= last_id)
);
ALTER TABLE audit_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_shipments FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_shipments_staff_read ON audit_shipments FOR SELECT USING (app_is_staff());
GRANT SELECT ON audit_shipments TO telus_app;    -- staff can see shipping progress; writes only via the function below
CREATE TRIGGER audit_shipments_no_update BEFORE UPDATE OR DELETE ON audit_shipments FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- Audit rows after `p_after` (NULL = after the last shipped row), in the exact text forms the chain hash is computed from,
-- so the shipped copy can be re-verified outside the database. Used by the shipper and by `audit:verify`.
CREATE FUNCTION audit_export(p_after bigint, p_limit int)
RETURNS TABLE (id bigint, actor_sub text, actor_kind text, action text, reference_type text, reference_id text,
               before_value text, after_value text, ip text, created_at text, prev_hash text, hash text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM require_system();
  RETURN QUERY
    SELECT a.id, a.actor_sub, a.actor_kind, a.action, a.reference_type, a.reference_id,
           a.before_value::text, a.after_value::text, host(a.ip),
           to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), a.prev_hash, a.hash
      FROM audit_logs a
     WHERE a.id > coalesce(p_after, (SELECT max(s.last_id) FROM audit_shipments s), 0)
     ORDER BY a.id
     LIMIT least(greatest(p_limit, 1), 10000);
END $$;

CREATE POLICY audit_shipments_system_read ON audit_shipments FOR SELECT USING (app_is_system());
-- Inserts happen only inside audit_record_shipment (the table grants telus_app no INSERT); FORCE'd RLS still applies to it.
CREATE POLICY audit_shipments_system_insert ON audit_shipments FOR INSERT WITH CHECK (app_is_system());

-- Records a batch AFTER its object is stored and locked. Refuses anything that does not extend the shipped chain.
CREATE FUNCTION audit_record_shipment(p_first bigint, p_last bigint, p_count int, p_first_prev text, p_last_hash text,
                                      p_key text, p_sha256 text, p_retain_until timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE prev audit_shipments;
BEGIN
  PERFORM require_system();
  PERFORM pg_advisory_xact_lock(727002);
  SELECT * INTO prev FROM audit_shipments ORDER BY last_id DESC LIMIT 1;
  IF p_first_prev IS DISTINCT FROM prev.last_hash OR (prev.id IS NOT NULL AND p_first <= prev.last_id) THEN
    RAISE EXCEPTION 'AUDIT_SHIPMENT_NOT_CONTIGUOUS' USING ERRCODE = '23514';
  END IF;
  IF (SELECT a.hash FROM audit_logs a WHERE a.id = p_last) IS DISTINCT FROM p_last_hash
     OR (SELECT count(*) FROM audit_logs a WHERE a.id BETWEEN p_first AND p_last) <> p_count THEN
    RAISE EXCEPTION 'AUDIT_SHIPMENT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  INSERT INTO audit_shipments (first_id, last_id, row_count, first_prev_hash, last_hash, object_key, sha256, retain_until)
  VALUES (p_first, p_last, p_count, p_first_prev, p_last_hash, p_key, p_sha256, p_retain_until);
END $$;

REVOKE EXECUTE ON FUNCTION audit_export(bigint, int), audit_record_shipment(bigint, bigint, int, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_export(bigint, int), audit_record_shipment(bigint, bigint, int, text, text, text, text, timestamptz) TO telus_app;
