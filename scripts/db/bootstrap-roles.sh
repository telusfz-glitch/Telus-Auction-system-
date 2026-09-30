#!/usr/bin/env bash
# One-off, idempotent: creates the databases and roles the platform expects on a fresh server (e.g. Amazon RDS), run as
# the server's administrator. Passwords come from the environment (in AWS: Secrets Manager → ECS task).
#
#   ADMIN_URL=postgres://<admin>@host:5432/postgres OWNER_PASSWORD=… APP_PASSWORD=… BACKUP_PASSWORD=… KEYCLOAK_PASSWORD=… \
#     scripts/db/bootstrap-roles.sh
#
# telus_owner  owns the schema and runs migrations — NOT a superuser (closes README gap 4).
# telus_app    the only role the API uses: no ownership, NOBYPASSRLS, so row-level security always applies.
# telus_backup read-only + BYPASSRLS, for scripts/db/backup.sh only.
# keycloak     owns the separate keycloak database.
set -euo pipefail
: "${ADMIN_URL:?}"; : "${OWNER_PASSWORD:?}"; : "${APP_PASSWORD:?}"; : "${BACKUP_PASSWORD:?}"; : "${KEYCLOAK_PASSWORD:?}"
APP_DB="${APP_DB:-telus}"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
  -v owner_pw="$OWNER_PASSWORD" -v app_pw="$APP_PASSWORD" -v backup_pw="$BACKUP_PASSWORD" -v kc_pw="$KEYCLOAK_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE telus_owner LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD %L', :'owner_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telus_owner') \gexec
SELECT format('CREATE ROLE telus_app LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD %L', :'app_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telus_app') \gexec
SELECT format('CREATE ROLE telus_backup LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB BYPASSRLS PASSWORD %L', :'backup_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telus_backup') \gexec
SELECT format('CREATE ROLE keycloak LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD %L', :'kc_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keycloak') \gexec
-- Re-running rotates the passwords to the current secrets.
SELECT format('ALTER ROLE telus_owner PASSWORD %L', :'owner_pw') \gexec
SELECT format('ALTER ROLE telus_app PASSWORD %L', :'app_pw') \gexec
SELECT format('ALTER ROLE telus_backup PASSWORD %L', :'backup_pw') \gexec
SELECT format('ALTER ROLE keycloak PASSWORD %L', :'kc_pw') \gexec
SQL
for db in "$APP_DB:telus_owner" "keycloak:keycloak"; do
  name="${db%%:*}"; owner="${db##*:}"
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qAtc "SELECT 1 FROM pg_database WHERE datname = '$name'" | grep -q 1 \
    || psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE \"$name\" OWNER $owner"
done
db_url="${ADMIN_URL%/*}/$APP_DB"
psql "$db_url" -v ON_ERROR_STOP=1 -q <<SQL
ALTER SCHEMA public OWNER TO telus_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE "$APP_DB" TO telus_app, telus_backup;
GRANT USAGE ON SCHEMA public TO telus_app, telus_backup;
-- Read-everything for backups: pg_read_all_data where the server allows granting it (self-managed, recent RDS);
-- otherwise equivalent explicit grants, kept current for tables the owner creates later.
DO \$\$ BEGIN
  GRANT pg_read_all_data TO telus_backup;
EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
  RAISE NOTICE 'pg_read_all_data not grantable here; using explicit grants';
  EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO telus_backup';
  EXECUTE 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO telus_backup';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE telus_owner IN SCHEMA public GRANT SELECT ON TABLES TO telus_backup';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE telus_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO telus_backup';
END \$\$;
SQL
echo "roles and databases ready"
