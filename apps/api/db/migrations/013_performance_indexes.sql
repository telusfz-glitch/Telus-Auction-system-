-- Indexes for queries that run on every bid or every page view and so far scanned whole tables (performance review,
-- docs/AUDIT.md). Plain CREATE INDEX: this runs before go-live on small tables. On a large live table, create the same
-- index with CREATE INDEX CONCURRENTLY outside a transaction first; IF NOT EXISTS then makes this migration a no-op.

-- Exposure check inside every bid (under the customer's lock) and the customers' RLS policy on lot_bid_state:
-- "which lots does this customer lead?". Without it, every bid reads every lot that ever had a bid.
CREATE INDEX IF NOT EXISTS lot_bid_state_leader_idx ON lot_bid_state (leader_customer_id);

-- "My highest bid on this lot" (lot table, my-status). bids_lot_idx alone walks every bid on a hot lot to find one
-- customer's; this goes straight to them.
CREATE INDEX IF NOT EXISTS bids_lot_customer_idx ON bids (lot_id, customer_id, amount DESC);

-- A customer's invoices, newest first (RLS filters invoices by customer).
CREATE INDEX IF NOT EXISTS invoices_customer_idx ON invoices (customer_id, created_at DESC);

-- A company's team logins (team page, bid-time login status check is by keycloak_sub, already unique).
CREATE INDEX IF NOT EXISTS customer_users_customer_idx ON customer_users (customer_id);
