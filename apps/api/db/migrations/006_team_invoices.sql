-- 006_team_invoices: customer team logins (managed through the Keycloak Admin API) and invoice settlement.

-- ---------- customer_users: the local record of each customer login ----------
ALTER TABLE customer_users
  ADD COLUMN email text,
  ADD COLUMN created_by text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX customer_users_email_uq ON customer_users (lower(email)) WHERE email IS NOT NULL;

-- Rows are never deleted: a login is suspended instead (the row is the evidence of who could act for the customer).
DROP POLICY cu_admin_del ON customer_users;
REVOKE DELETE ON customer_users FROM telus_app;

-- Identity columns are immutable: nobody can re-point a row at another Keycloak user, another customer or another email.
CREATE FUNCTION customer_users_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.keycloak_sub IS DISTINCT FROM OLD.keycloak_sub OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.email IS DISTINCT FROM OLD.email OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'CUSTOMER_USER_IDENTITY_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER customer_users_guard_trg BEFORE UPDATE ON customer_users FOR EACH ROW EXECUTE FUNCTION customer_users_guard();

-- ---------- invoices: unpaid → paid | void, and nothing else ever changes ----------
ALTER TABLE invoices
  ADD COLUMN settled_at timestamptz,
  ADD COLUMN settled_by text,
  ADD COLUMN settlement_note text CHECK (length(settlement_note) <= 500);

CREATE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
     OR NEW.auction_id IS DISTINCT FROM OLD.auction_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'unpaid' AND NEW.status IN ('paid', 'void')) THEN
    RAISE EXCEPTION 'INVOICE_TRANSITION_FORBIDDEN: % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'unpaid' AND (NEW.settled_at IS DISTINCT FROM OLD.settled_at OR NEW.settled_by IS DISTINCT FROM OLD.settled_by
     OR NEW.settlement_note IS DISTINCT FROM OLD.settlement_note) THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_guard_trg BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_guard();
CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION forbid_modification();
