-- 007_notifications: email notifications, fed by the transactional outbox.
-- The outbox publisher calls email_enqueue_for_events() inside the SAME transaction that claims the events, so every
-- event produces its emails exactly once in effect: a crash rolls both back, and a redelivered event hits the dedupe keys.
-- The email worker then claims queued emails (SKIP LOCKED), sends them and records the outcome with retry/backoff.

-- Invoices are written by finalisation; announce them through the outbox like every other domain event.
CREATE FUNCTION invoices_notify() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO outbox_events (type, payload) VALUES ('invoice.issued',
    jsonb_build_object('invoiceId', NEW.id, 'customerId', NEW.customer_id, 'auctionId', NEW.auction_id));
  RETURN NULL;
END $$;
CREATE TRIGGER invoices_notify_trg AFTER INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_notify();

CREATE TABLE email_queue (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('lot.outbid', 'auction.won', 'auction.cancelled', 'invoice.issued')),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  auction_id      uuid REFERENCES auctions(id),
  dedupe_key      text NOT NULL UNIQUE,
  payload         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX email_queue_due_idx ON email_queue (next_attempt_at) WHERE status = 'pending';
ALTER TABLE email_queue ENABLE ROW LEVEL SECURITY;   -- no policies: reachable only through the functions below
CREATE POLICY eq_staff_read ON email_queue FOR SELECT USING (app_is_staff());
GRANT SELECT ON email_queue TO telus_app;

-- Turns claimed outbox events into queued emails. Confidentiality mirrors the realtime routing: an outbid notice names
-- the lot and auction, never the competitor, and carries the price only in 'full_price' auctions.
CREATE FUNCTION email_enqueue_for_events(p_ids bigint[]) RETURNS int LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE e record; n int := 0; k int;
BEGIN
  PERFORM require_system();
  FOR e IN SELECT id, type, payload, created_at FROM outbox_events WHERE id = ANY (p_ids) ORDER BY id LOOP
    IF e.type = 'bid.accepted' AND (e.payload->>'previousLeaderCustomerId') IS NOT NULL
       AND e.payload->>'previousLeaderCustomerId' <> e.payload->>'leaderCustomerId' THEN
      -- At most one outbid email per customer, per lot, per 10 minutes: a bidding war must not become a mail flood.
      INSERT INTO email_queue (kind, customer_id, auction_id, dedupe_key, payload)
      VALUES ('lot.outbid', (e.payload->>'previousLeaderCustomerId')::uuid, (e.payload->>'auctionId')::uuid,
              format('outbid:%s:%s:%s', e.payload->>'previousLeaderCustomerId', e.payload->>'lotId',
                     floor(extract(epoch FROM e.created_at) / 600)),
              jsonb_build_object('lotId', e.payload->'lotId',
                                 'highestBid', CASE WHEN e.payload->>'visibility' = 'full_price' THEN e.payload->'amount' END))
      ON CONFLICT (dedupe_key) DO NOTHING;
      GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    ELSIF e.type = 'auction.closed' THEN
      INSERT INTO email_queue (kind, customer_id, auction_id, dedupe_key)
      SELECT DISTINCT 'auction.won', r.winner_customer_id, r.auction_id, format('won:%s:%s', r.auction_id, r.winner_customer_id)
        FROM lot_results r WHERE r.auction_id = (e.payload->>'auctionId')::uuid AND r.outcome = 'won'
      ON CONFLICT (dedupe_key) DO NOTHING;
      GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    ELSIF e.type = 'auction.cancelled' THEN
      INSERT INTO email_queue (kind, customer_id, auction_id, dedupe_key)
      SELECT 'auction.cancelled', ap.customer_id, ap.auction_id, format('cancelled:%s:%s', ap.auction_id, ap.customer_id)
        FROM auction_participants ap
       WHERE ap.auction_id = (e.payload->>'auctionId')::uuid AND ap.is_allowed
         AND (e.payload->>'previousStatus') <> 'draft'          -- drafts were never visible to customers
      ON CONFLICT (dedupe_key) DO NOTHING;
      GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    ELSIF e.type = 'invoice.issued' THEN
      INSERT INTO email_queue (kind, customer_id, auction_id, dedupe_key, payload)
      VALUES ('invoice.issued', (e.payload->>'customerId')::uuid, (e.payload->>'auctionId')::uuid,
              format('invoice:%s', e.payload->>'invoiceId'), jsonb_build_object('invoiceId', e.payload->'invoiceId'))
      ON CONFLICT (dedupe_key) DO NOTHING;
      GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- Claims due emails with everything needed to render them. Recipients: the customer's active logins that can act
-- (admins and bidders for outbid notices; every active login for the rest) plus the company contact for results,
-- cancellations and invoices. The content is assembled from the customer's OWN data only.
CREATE FUNCTION email_claim(p_limit int) RETURNS TABLE (
  id bigint, kind text, attempts int, customer_code text, company_name text, recipients text[],
  auction_id uuid, auction_number text, auction_name text, details jsonb
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM require_system();
  RETURN QUERY
  WITH due AS (
    SELECT q.* FROM email_queue q WHERE q.status = 'pending' AND q.next_attempt_at <= clock_timestamp()
     ORDER BY q.id LIMIT least(greatest(p_limit, 1), 200) FOR UPDATE SKIP LOCKED
  )
  SELECT d.id, d.kind, d.attempts, cu.code, cu.company_name,
         ARRAY(SELECT DISTINCT lower(x) FROM (
                 SELECT u.email AS x FROM customer_users u
                  WHERE u.customer_id = d.customer_id AND u.status = 'active' AND u.email IS NOT NULL
                    AND (d.kind <> 'lot.outbid' OR u.role IN ('customer_admin', 'customer_bidder'))
                 UNION ALL
                 SELECT cu.contact_email WHERE d.kind <> 'lot.outbid') s WHERE x IS NOT NULL ORDER BY 1),
         d.auction_id, a.number, a.name,
         CASE d.kind
           WHEN 'lot.outbid' THEN (SELECT jsonb_build_object('lotNumber', l.lot_number, 'description', l.description,
                                          'highestBid', d.payload->'highestBid', 'closeAt', a.close_at)
                                     FROM auction_lots l WHERE l.id = (d.payload->>'lotId')::uuid)
           WHEN 'auction.won' THEN (SELECT jsonb_build_object('lots', coalesce(jsonb_agg(jsonb_build_object(
                                          'lotNumber', l.lot_number, 'description', l.description, 'quantity', r.quantity,
                                          'unitPrice', r.unit_price::text, 'total', r.total::text) ORDER BY l.lot_number), '[]'),
                                          'grandTotal', coalesce(sum(r.total), 0)::text)
                                      FROM lot_results r JOIN auction_lots l ON l.id = r.lot_id
                                     WHERE r.auction_id = d.auction_id AND r.winner_customer_id = d.customer_id AND r.outcome = 'won')
           WHEN 'invoice.issued' THEN (SELECT jsonb_build_object('invoiceNumber', i.invoice_number, 'total', i.total_amount::text)
                                         FROM invoices i WHERE i.id = (d.payload->>'invoiceId')::uuid)
           ELSE '{}'::jsonb
         END
    FROM due d JOIN customers cu ON cu.id = d.customer_id LEFT JOIN auctions a ON a.id = d.auction_id;
END $$;

-- Outcome of one send. Failures retry with exponential backoff (1, 2, 4 … 256 min) and give up after 10 attempts.
CREATE FUNCTION email_mark(p_id bigint, p_outcome text, p_error text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM require_system();
  IF p_outcome IN ('sent', 'skipped') THEN
    UPDATE email_queue SET status = p_outcome, sent_at = clock_timestamp(), attempts = attempts + 1, last_error = left(p_error, 500)
     WHERE id = p_id AND status = 'pending';
  ELSE
    UPDATE email_queue SET attempts = attempts + 1, last_error = left(p_error, 500),
           status = CASE WHEN attempts + 1 >= 10 THEN 'failed' ELSE 'pending' END,
           next_attempt_at = clock_timestamp() + make_interval(mins => power(2, least(attempts, 8))::int)
     WHERE id = p_id AND status = 'pending';
  END IF;
END $$;

-- Customers and their logins are FORCE'd-RLS tables; the owner-run email functions read them in the system context.
CREATE POLICY customers_system_read ON customers FOR SELECT USING (app_is_system());
CREATE POLICY cu_system_read ON customer_users FOR SELECT USING (app_is_system());
CREATE POLICY ap_system_read ON auction_participants FOR SELECT USING (app_is_system());
CREATE POLICY invoices_system_read ON invoices FOR SELECT USING (app_is_system());

REVOKE EXECUTE ON FUNCTION email_enqueue_for_events(bigint[]), email_claim(int), email_mark(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION email_enqueue_for_events(bigint[]), email_claim(int), email_mark(bigint, text, text) TO telus_app;
