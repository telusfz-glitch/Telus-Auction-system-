#!/usr/bin/env bash
# Proves a backup is usable: restores it into a throwaway database and checks what matters for an auction house.
#
#   DRILL_ADMIN_URL=postgres://<admin>@host:5432/postgres  scripts/db/restore-drill.sh telus-….dump[.gpg]  [SOURCE_URL]
#
# DRILL_ADMIN_URL: an administrator of an ISOLATED restore server (never production). Rows must come back byte for byte,
# so the restore runs with triggers disabled (the audit-chain trigger would otherwise renumber the log and the bid
# safety net would refuse bids on closed auctions) — that needs superuser (or the cloud's admin role).
# SOURCE_URL (optional, the telus_backup role): also compare row counts with the live database — only meaningful
# right after the backup. KEEP=1 keeps the restored database for inspection. Exit 0 = every check passed.
set -euo pipefail
: "${DRILL_ADMIN_URL:?set DRILL_ADMIN_URL (admin of an isolated restore server)}"
dump="${1:?backup file}"
source_url="${2:-}"
here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../../apps/api/db/migrations"
fail=0
check() { if [ "$2" = "$3" ]; then echo "  ok    $1"; else echo "  FAIL  $1 (got '$2', expected '$3')"; fail=1; fi; }

# Explicit if/else: under `set -e` a failure inside an `a && b` list does NOT stop the script.
if [ -f "$dump.sha256" ]; then
  if (cd "$(dirname "$dump")" && sha256sum --check --quiet "$(basename "$dump").sha256"); then echo "  ok    checksum"
  else echo "  FAIL  checksum — the file is damaged or not the one that was written; nothing restored"; exit 1; fi
else
  echo "  WARN  no $dump.sha256 next to the backup: integrity of the file itself not verified"
fi
work="$dump"
if [[ "$dump" == *.gpg ]]; then work="$(mktemp)"; gpg --batch --quiet --decrypt --output "$work" "$dump"; fi

db="telus_restore_drill_$(date +%s)_$$"
target="${DRILL_ADMIN_URL%/*}/$db"
psql "$DRILL_ADMIN_URL" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $db"
cleanup() {
  [ "$work" != "$dump" ] && rm -f "$work"
  if [ "${KEEP:-0}" = "1" ]; then echo "kept: $db"; else psql "$DRILL_ADMIN_URL" -qc "DROP DATABASE IF EXISTS $db" >/dev/null; fi
}
trap cleanup EXIT
pg_restore --dbname="$target" --exit-on-error --disable-triggers --single-transaction --no-password "$work"
echo "restored into $db"

q() { psql "$target" -v ON_ERROR_STOP=1 -Atc "$1"; }
check "all migrations present" "$(q 'SELECT count(*) FROM schema_migrations')" "$(ls "$migrations"/*.sql | wc -l | tr -d ' ')"
check "audit hash chain intact" "$(q 'SELECT coalesce(verify_audit_chain()::text, '"'"'intact'"'"')')" "intact"
check "every lot's price equals the top of its bid ledger" \
  "$(q 'SELECT count(*) FROM lot_bid_state s WHERE s.highest_amount IS DISTINCT FROM (SELECT max(amount) FROM bids b WHERE b.lot_id = s.lot_id)')" "0"
check "every invoice total equals the sum of its lines" \
  "$(q 'SELECT count(*) FROM invoices i WHERE EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id) AND i.total_amount <> (SELECT sum(amount) FROM invoice_lines l WHERE l.invoice_id = i.id)')" "0"
check "row-level security still forced (tables)" "$(q "SELECT count(*) FROM pg_class WHERE relkind = 'r' AND relforcerowsecurity AND relnamespace = 'public'::regnamespace")" \
  "$(if [ -n "$source_url" ]; then psql "$source_url" -Atc "SELECT count(*) FROM pg_class WHERE relkind = 'r' AND relforcerowsecurity AND relnamespace = 'public'::regnamespace"; else q "SELECT count(*) FROM pg_class WHERE relkind = 'r' AND relforcerowsecurity AND relnamespace = 'public'::regnamespace"; fi)"
check "append-only triggers present on audit_logs" "$(q "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal")" "3"
if [ -n "$source_url" ]; then
  counts="SELECT string_agg(t || '=' || n, ',' ORDER BY t) FROM (SELECT c.relname AS t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I', c.relname), false, false, '')))[1]::text AS n FROM pg_class c WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace) x"
  check "row counts match the source" "$(q "$counts")" "$(psql "$source_url" -Atc "$counts")"
fi
[ "$fail" = 0 ] && echo "RESTORE DRILL PASSED" || { echo "RESTORE DRILL FAILED"; exit 1; }
