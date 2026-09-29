-- 012_card_payments: invoices paid online by card through a hosted payment page (Stripe Checkout). Card data never
-- reaches this system; it only records the provider's session and, on the provider's signed confirmation, settles the
-- invoice — once, for exactly the invoice amount in AED.
CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id          uuid NOT NULL REFERENCES invoices(id),
  customer_id         uuid NOT NULL REFERENCES customers(id),
  provider            text NOT NULL CHECK (provider IN ('stripe')),
  provider_session_id text NOT NULL UNIQUE,
  provider_payment_id text,
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  currency            text NOT NULL DEFAULT 'AED' CHECK (currency = 'AED'),
  status              text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'succeeded', 'expired', 'failed', 'rejected')),
  status_detail       text CHECK (length(status_detail) <= 300),
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);
CREATE INDEX payments_invoice_idx ON payments (invoice_id);
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY payments_staff_read ON payments FOR SELECT USING (app_is_staff());
CREATE POLICY payments_self_read ON payments FOR SELECT USING (customer_id = app_customer_id());
-- A customer administrator may open a payment for an UNPAID invoice of their own company, for its exact total.
CREATE POLICY payments_self_start ON payments FOR INSERT WITH CHECK (
  customer_id = app_customer_id() AND app_customer_role() = 'customer_admin' AND created_by = app_user_sub()
  AND status = 'created' AND provider_payment_id IS NULL AND completed_at IS NULL
  AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND i.customer_id = app_customer_id()
              AND i.status = 'unpaid' AND i.total_amount = amount));
CREATE POLICY payments_system ON payments FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT ON payments TO telus_app;   -- status changes only through the functions below
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- The webhook settles invoices in the system context.
CREATE POLICY invoices_system_settle ON invoices FOR UPDATE USING (app_is_system()) WITH CHECK (app_is_system());

/**
 * Called for the provider's signed "payment succeeded". Idempotent (redelivered webhooks return 'already'). Settles the
 * invoice only if the amount and currency match and it is still unpaid; otherwise records why and leaves it for finance.
 * Returns one of: settled | already | rejected:<reason> | unknown.
 */
CREATE FUNCTION payment_succeeded(p_session text, p_payment text, p_amount numeric, p_currency text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pay payments; inv invoices; reason text;
BEGIN
  PERFORM require_system();
  SELECT * INTO pay FROM payments WHERE provider_session_id = p_session FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  IF pay.status = 'succeeded' THEN RETURN 'already'; END IF;
  SELECT * INTO inv FROM invoices WHERE id = pay.invoice_id FOR UPDATE;
  reason := CASE
    WHEN upper(p_currency) <> pay.currency THEN 'currency ' || p_currency
    WHEN p_amount <> pay.amount OR p_amount <> inv.total_amount THEN 'amount ' || p_amount || ' <> ' || inv.total_amount
    WHEN inv.status <> 'unpaid' THEN 'invoice already ' || inv.status
  END;
  IF reason IS NOT NULL THEN
    -- Money was taken but cannot be applied automatically: keep a precise record for finance to refund or apply.
    UPDATE payments SET status = 'rejected', provider_payment_id = p_payment, status_detail = reason, completed_at = now() WHERE id = pay.id;
    INSERT INTO audit_logs (actor_sub, actor_kind, action, reference_type, reference_id, after_value)
    VALUES (app_user_sub(), 'system', 'payment.rejected', 'payment', pay.id::text,
            jsonb_build_object('invoiceId', inv.id, 'providerPayment', p_payment, 'reason', reason));
    RETURN 'rejected:' || reason;
  END IF;
  UPDATE payments SET status = 'succeeded', provider_payment_id = p_payment, completed_at = now() WHERE id = pay.id;
  UPDATE invoices SET status = 'paid', settled_at = now(), settled_by = app_user_sub(),
         settlement_note = 'Card payment ' || p_payment WHERE id = inv.id;
  INSERT INTO audit_logs (actor_sub, actor_kind, action, reference_type, reference_id, before_value, after_value)
  VALUES (app_user_sub(), 'system', 'invoice.paid_by_card', 'invoice', inv.id::text, jsonb_build_object('status', 'unpaid'),
          jsonb_build_object('status', 'paid', 'payment', pay.id, 'providerPayment', p_payment, 'amount', p_amount));
  RETURN 'settled';
END $$;

/** The provider says this checkout ended without payment (expired / failed). Never touches the invoice. */
CREATE FUNCTION payment_ended(p_session text, p_status text, p_detail text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM require_system();
  IF p_status NOT IN ('expired', 'failed') THEN RAISE EXCEPTION 'bad status %', p_status; END IF;
  UPDATE payments SET status = p_status, status_detail = left(p_detail, 300), completed_at = now()
   WHERE provider_session_id = p_session AND status = 'created';
  RETURN CASE WHEN FOUND THEN p_status ELSE 'ignored' END;
END $$;

REVOKE EXECUTE ON FUNCTION payment_succeeded(text, text, numeric, text), payment_ended(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payment_succeeded(text, text, numeric, text), payment_ended(text, text, text) TO telus_app;
