#!/bin/bash
# Runs once on first container start. telus_app is the ONLY role the API connects as:
# not superuser, not owner, NOBYPASSRLS — so row-level security always applies to it.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE telus_app LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE keycloak LOGIN PASSWORD '${KEYCLOAK_DB_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  CREATE DATABASE keycloak OWNER keycloak;
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO telus_app;
EOSQL
