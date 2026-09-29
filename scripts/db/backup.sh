#!/usr/bin/env bash
# Logical backup of the auction database: one consistent snapshot (pg_dump custom format), a SHA-256 next to it, and —
# when BACKUP_GPG_RECIPIENT is set — the dump encrypted to that public key (the plaintext is then removed).
#
#   BACKUP_DB_URL=postgres://telus_backup:…@host:5432/telus  [BACKUP_S3_URI=s3://bucket/prefix/]  scripts/db/backup.sh [out-dir]
#
# Connect as telus_backup: read-only (pg_read_all_data) with BYPASSRLS. Row-level security is FORCE'd even for the
# table owner, so any other role would dump an incomplete database — pg_dump refuses rather than do that.
# Store the output off-site with a retention lock, and prove it restores: scripts/db/restore-drill.sh.
set -euo pipefail
: "${BACKUP_DB_URL:?set BACKUP_DB_URL (the telus_backup role)}"
out="${1:-.}"
mkdir -p "$out"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$out/telus-$stamp.dump"
pg_dump --dbname="$BACKUP_DB_URL" --format=custom --compress=6 --no-password --file="$file"
if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  gpg --batch --yes --trust-model always --recipient "$BACKUP_GPG_RECIPIENT" --output "$file.gpg" --encrypt "$file"
  rm -f "$file"
  file="$file.gpg"
fi
( cd "$(dirname "$file")" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256" )
# Off-site copy (in AWS: the backups bucket, Object Lock). The local files are then removed: the container is ephemeral.
if [ -n "${BACKUP_S3_URI:-}" ]; then
  node "$(dirname "$0")/s3-put.js" "$BACKUP_S3_URI" "$file" "$file.sha256" >&2
  [ "${BACKUP_KEEP_LOCAL:-0}" = "1" ] || rm -f "$file" "$file.sha256"
fi
echo "$file"
