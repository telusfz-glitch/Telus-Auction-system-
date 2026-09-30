-- 005_realtime_tickets: single-use enforcement for socket tickets.
-- A browser never holds a Keycloak access token (the web app keeps tokens server-side). To open a socket it gets a
-- short-lived ticket from the API through the web server. Tickets are HMAC-signed JWTs (verified in the gateway);
-- this table makes each one usable exactly once, across every API instance.

CREATE TABLE realtime_ticket_uses (
  jti        uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
ALTER TABLE realtime_ticket_uses ENABLE ROW LEVEL SECURITY;   -- no policies and no grants: reachable only via the function below

CREATE FUNCTION realtime_ticket_consume(p_jti uuid, p_expires_at timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM require_system();
  IF p_expires_at <= clock_timestamp() THEN RETURN false; END IF;
  -- Rows are only needed until the ticket would have expired anyway; the table stays tiny.
  DELETE FROM realtime_ticket_uses WHERE expires_at < clock_timestamp() - interval '1 minute';
  INSERT INTO realtime_ticket_uses (jti, expires_at) VALUES (p_jti, p_expires_at) ON CONFLICT (jti) DO NOTHING;
  RETURN FOUND;
END $$;
REVOKE EXECUTE ON FUNCTION realtime_ticket_consume(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION realtime_ticket_consume(uuid, timestamptz) TO telus_app;
