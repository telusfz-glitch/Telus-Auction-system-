#!/usr/bin/env bash
# Usage: TEMP_PASSWORD='...' infra/keycloak/create-user.sh <email> <role> [customer_uuid]
# Every new user must set a new password AND enrol TOTP MFA at first login (required actions).
# NOTE: the temp password is visible in the process list during this one-time bootstrap call.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
EMAIL="${1:?email}"; ROLE="${2:?role}"; CUSTOMER_ID="${3:-}"
: "${TEMP_PASSWORD:?set TEMP_PASSWORD}"
case "$ROLE" in
  super_admin|auction_manager|sales_manager|finance|view_only) ;;
  customer_admin|customer_bidder|customer_viewer)
    [[ "$CUSTOMER_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "customer roles require a customer UUID"; exit 1; } ;;
  *) echo "unknown role: $ROLE"; exit 1 ;;
esac
KC="docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh"
$KC config credentials --server http://localhost:8080 --realm master --user "$KEYCLOAK_ADMIN_USER" --password "$KEYCLOAK_ADMIN_PASSWORD"
ATTR=(); [ -n "$CUSTOMER_ID" ] && ATTR=(-s "attributes.customer_id=$CUSTOMER_ID")
$KC create users -r telus -s username="$EMAIL" -s email="$EMAIL" -s enabled=true -s emailVerified=true \
   -s 'requiredActions=["CONFIGURE_TOTP","UPDATE_PASSWORD"]' "${ATTR[@]}"
$KC set-password -r telus --username "$EMAIL" --new-password "$TEMP_PASSWORD" --temporary
$KC add-roles -r telus --uusername "$EMAIL" --rolename "$ROLE"
echo "Created $EMAIL with role $ROLE (must change password + enrol TOTP at first login)."
