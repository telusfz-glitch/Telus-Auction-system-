-- 009_notification_prefs: each customer login can turn outbid emails off for itself.
-- Results, cancellations and invoices are always sent (they are records, not alerts).

ALTER TABLE customer_users ADD COLUMN notify_outbid boolean NOT NULL DEFAULT true;

-- Any customer login may update ITS OWN row, but (guard below) only this preference.
CREATE POLICY cu_self_prefs ON customer_users FOR UPDATE
  USING (keycloak_sub = app_user_sub() AND customer_id = app_customer_id())
  WITH CHECK (keycloak_sub = app_user_sub() AND customer_id = app_customer_id());

CREATE OR REPLACE FUNCTION customer_users_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.keycloak_sub IS DISTINCT FROM OLD.keycloak_sub OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.email IS DISTINCT FROM OLD.email OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'CUSTOMER_USER_IDENTITY_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF app_kind() = 'customer' THEN
    -- Your own login: only your preference (an admin cannot re-role or reactivate themselves this way).
    IF OLD.keycloak_sub = app_user_sub() AND (NEW.role, NEW.status) IS DISTINCT FROM (OLD.role, OLD.status) THEN
      RAISE EXCEPTION 'CUSTOMER_USER_SELF_CHANGE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- Someone else's login: never their personal preference.
    IF OLD.keycloak_sub <> app_user_sub() AND NEW.notify_outbid IS DISTINCT FROM OLD.notify_outbid THEN
      RAISE EXCEPTION 'CUSTOMER_USER_PREFERENCE_IS_PERSONAL' USING ERRCODE = '42501';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Outbid notices skip logins that opted out.
CREATE OR REPLACE FUNCTION email_claim(p_limit int) RETURNS TABLE (
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
                    AND (d.kind <> 'lot.outbid' OR (u.role IN ('customer_admin', 'customer_bidder') AND u.notify_outbid))
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
