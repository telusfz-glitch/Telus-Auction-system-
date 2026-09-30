#!/usr/bin/env bash
# Monthly restore drill (in AWS: a scheduled ECS task). Downloads the newest backup from S3, starts a throwaway
# PostgreSQL 16 inside this container (a true superuser, isolated from production, gone when the task ends), restores
# the backup into it with scripts/db/restore-drill.sh and runs every check. Exit 0 = the backup is usable; any other
# exit raises the "task failed" alarm.
#
#   DRILL_S3_URI=s3://bucket/daily/  [DRILL_MAX_AGE_HOURS=36]  scripts/db/scheduled-drill.sh
#
# Also fails when the newest backup is older than DRILL_MAX_AGE_HOURS: a nightly backup that silently stopped is caught.
set -euo pipefail
: "${DRILL_S3_URI:?set DRILL_S3_URI (where backup.sh uploads, e.g. s3://…-backups/daily/)}"
max_age="${DRILL_MAX_AGE_HOURS:-36}"
here="$(cd "$(dirname "$0")" && pwd)"
pgbin="${PG_BIN:-/usr/lib/postgresql/16/bin}"
work="$(mktemp -d "${TMPDIR:-/tmp}/drill.XXXXXX")"
port="${DRILL_PORT:-55432}"
cleanup() { "$pgbin/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

mkdir -p "$work/in"
read -r dump age < <(node "$here/s3-get-latest.js" "$DRILL_S3_URI" "$work/in")
echo "newest backup: $(basename "$dump") (${age} h old)"
if awk -v a="$age" -v m="$max_age" 'BEGIN { exit !(a > m) }'; then
  echo "  FAIL  newest backup is ${age} h old (limit ${max_age} h): the nightly backup is not running"; exit 1
fi

# Local-only server: no TCP listener outside the container, trust auth for the one local user.
"$pgbin/initdb" -D "$work/data" -U drill --auth=trust --encoding=UTF8 --no-instructions >/dev/null
"$pgbin/pg_ctl" -D "$work/data" -l "$work/server.log" -w \
  -o "-c listen_addresses=127.0.0.1 -p $port -k $work -c fsync=off -c full_page_writes=off -c max_wal_size=4GB" start >/dev/null
# The roles the backup's ownership and grants refer to (no login: nothing can connect as them here).
psql "postgres://drill@127.0.0.1:$port/postgres" -v ON_ERROR_STOP=1 -qc \
  "CREATE ROLE telus_owner; CREATE ROLE telus_app; CREATE ROLE telus_backup; CREATE ROLE keycloak;"
DRILL_ADMIN_URL="postgres://drill@127.0.0.1:$port/postgres" "$here/restore-drill.sh" "$dump"
