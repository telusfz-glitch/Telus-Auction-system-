-- 011_ops_metrics: one read-only, system-only snapshot of the backlogs operators alert on (scraped via GET /metrics).
-- Counts only — no customer data leaves this function.
CREATE FUNCTION ops_metrics() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE shipped bigint;
BEGIN
  PERFORM require_system();
  SELECT coalesce(max(last_id), 0) INTO shipped FROM audit_shipments;
  RETURN jsonb_build_object(
    'outbox_unpublished', (SELECT count(*) FROM outbox_events WHERE published_at IS NULL),
    'outbox_oldest_unpublished_seconds',
      coalesce((SELECT extract(epoch FROM now() - min(created_at)) FROM outbox_events WHERE published_at IS NULL), 0),
    'email_pending', (SELECT count(*) FROM email_queue WHERE status = 'pending'),
    'email_failed', (SELECT count(*) FROM email_queue WHERE status = 'failed'),
    'email_oldest_pending_seconds',
      coalesce((SELECT extract(epoch FROM now() - min(created_at)) FROM email_queue WHERE status = 'pending'), 0),
    'audit_unshipped_rows', (SELECT count(*) FROM audit_logs WHERE id > shipped),
    'audit_oldest_unshipped_seconds',
      coalesce((SELECT extract(epoch FROM now() - min(created_at)) FROM audit_logs WHERE id > shipped), 0),
    'auctions_live', (SELECT count(*) FROM auctions WHERE status = 'live')
  );
END $$;
REVOKE EXECUTE ON FUNCTION ops_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_metrics() TO telus_app;
