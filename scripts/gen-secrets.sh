#!/usr/bin/env bash
# Generates a .env with random secrets (hex only, so they are safe inside SQL/URLs). Never overwrites.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -e .env ] && { echo ".env already exists — refusing to overwrite."; exit 1; }
r() { openssl rand -hex 24; }
OWNER=$(r); APP=$(r); KCDB=$(r); REDIS=$(r); WEBSECRET=$(r); APIADMIN=$(r)
cat > .env <<ENVEOF
OWNER_DB_PASSWORD=$OWNER
APP_DB_PASSWORD=$APP
KEYCLOAK_DB_PASSWORD=$KCDB
REDIS_PASSWORD=$REDIS
KEYCLOAK_ADMIN_USER=kcadmin
KEYCLOAK_ADMIN_PASSWORD=$(r)
# API runtime (connects as the restricted telus_app role)
DATABASE_URL=postgres://telus_app:$APP@localhost:5432/telus
# Migrations only (owner) — never give this to the running API
OWNER_DATABASE_URL=postgres://telus_owner:$OWNER@localhost:5432/telus
KEYCLOAK_ISSUER=http://localhost:8080/realms/telus
API_AUDIENCE=telus-api
CORS_ORIGINS=http://localhost:3000
REDIS_URL=redis://:$REDIS@localhost:6379
# Socket tickets for browsers (API) — used for nothing else
REALTIME_TICKET_SECRET=$(r)
# Keycloak realm import placeholders (telus-realm.json) — the web app's confidential client
TELUS_WEB_URL=http://localhost:3000
TELUS_WEB_CLIENT_SECRET=$WEBSECRET
TELUS_API_ADMIN_CLIENT_SECRET=$APIADMIN
# API: customer team logins via the Keycloak Admin API (service account telus-api-admin) — protect like the DB password
KEYCLOAK_ADMIN_CLIENT_SECRET=$APIADMIN
# Web app (apps/web): server-side sessions; the browser never sees a token
WEB_URL=http://localhost:3000
OIDC_ISSUER=http://localhost:8080/realms/telus
OIDC_CLIENT_ID=telus-web
OIDC_CLIENT_SECRET=$WEBSECRET
API_URL=http://localhost:4000
API_PUBLIC_URL=http://localhost:4000
SESSION_SECRET=$(r)
ENVEOF
chmod 600 .env
echo ".env written (mode 600)."
