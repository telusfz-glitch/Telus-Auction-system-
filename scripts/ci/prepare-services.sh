#!/usr/bin/env bash
# CI only: prepares the Postgres roles/databases the test suites expect and starts Keycloak with the repo realm.
# Every value here is a throwaway test credential for an ephemeral CI runner.
set -euo pipefail
export PGPASSWORD=postgres
psql -h localhost -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE telus_owner LOGIN PASSWORD 'owner' NOSUPERUSER CREATEDB;
CREATE ROLE telus_app   LOGIN PASSWORD 'app'   NOSUPERUSER NOBYPASSRLS;
CREATE ROLE telus_backup LOGIN PASSWORD 'backup' NOSUPERUSER BYPASSRLS;
GRANT pg_read_all_data TO telus_backup;
CREATE DATABASE telus_test OWNER telus_owner;
CREATE DATABASE telus_e2e_test OWNER telus_owner;
SQL
for db in telus_test telus_e2e_test; do
  psql -h localhost -U postgres -d "$db" -v ON_ERROR_STOP=1 -c "ALTER SCHEMA public OWNER TO telus_owner; GRANT CONNECT ON DATABASE $db TO telus_app;"
done

if [ "${WITH_KEYCLOAK:-1}" = "1" ]; then
  # Host networking: Keycloak must reach the web app on localhost:3000 for back-channel logout.
  docker run -d --name keycloak --network host \
    -e KC_BOOTSTRAP_ADMIN_USERNAME=kcadmin -e KC_BOOTSTRAP_ADMIN_PASSWORD=kcadminpw \
    -e TELUS_WEB_URL=http://localhost:3000 \
    -e TELUS_WEB_CLIENT_SECRET=e2e-web-client-secret-0123456789 \
    -e TELUS_API_ADMIN_CLIENT_SECRET=e2e-api-admin-secret-0123456789 \
    -v "$PWD/infra/keycloak/telus-realm.json:/opt/keycloak/data/import/telus-realm.json:ro" \
    quay.io/keycloak/keycloak:26.6.4 start-dev --import-realm
  for i in $(seq 1 90); do
    curl -sf http://localhost:8080/realms/telus/.well-known/openid-configuration >/dev/null && { echo "Keycloak ready after $((i * 2))s"; exit 0; }
    sleep 2
  done
  docker logs keycloak | tail -50
  echo "Keycloak did not start"; exit 1
fi
