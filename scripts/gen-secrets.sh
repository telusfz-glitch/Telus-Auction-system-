#!/usr/bin/env bash
# Generates a .env with random secrets (hex only, so they are safe inside SQL/URLs). Never overwrites.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -e .env ] && { echo ".env already exists — refusing to overwrite."; exit 1; }
r() { openssl rand -hex 24; }
OWNER=$(r); APP=$(r); KCDB=$(r)
cat > .env <<ENVEOF
OWNER_DB_PASSWORD=$OWNER
APP_DB_PASSWORD=$APP
KEYCLOAK_DB_PASSWORD=$KCDB
REDIS_PASSWORD=$(r)
KEYCLOAK_ADMIN_USER=kcadmin
KEYCLOAK_ADMIN_PASSWORD=$(r)
# API runtime (connects as the restricted telus_app role)
DATABASE_URL=postgres://telus_app:$APP@localhost:5432/telus
# Migrations only (owner) — never give this to the running API
OWNER_DATABASE_URL=postgres://telus_owner:$OWNER@localhost:5432/telus
KEYCLOAK_ISSUER=http://localhost:8080/realms/telus
API_AUDIENCE=telus-api
CORS_ORIGINS=http://localhost:3000
ENVEOF
chmod 600 .env
echo ".env written (mode 600)."
