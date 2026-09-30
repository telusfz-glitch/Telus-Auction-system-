# Generated secrets live in Secrets Manager (and, unavoidably, in Terraform state: keep the state bucket encrypted and
# access-restricted). ECS injects individual JSON keys as environment variables; nothing is baked into images.
resource "random_password" "gen" {
  for_each = toset(["owner_db", "app_db", "backup_db", "keycloak_db", "session", "realtime_ticket", "oidc_web", "kc_api_admin", "metrics", "kc_bootstrap", "client_ip_forward"])
  length   = 48
  special  = false
}

locals {
  db_host = aws_db_instance.main.address
  pg_tls  = "sslmode=verify-full&sslrootcert=/app/rds-ca.pem" # the RDS CA bundle is in the API/ops images
  redis   = "rediss://:${random_password.redis_auth.result}@${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
  app_secret = {
    DATABASE_URL                 = "postgres://telus_app:${random_password.gen["app_db"].result}@${local.db_host}:5432/telus?${local.pg_tls}"
    OWNER_DATABASE_URL           = "postgres://telus_owner:${random_password.gen["owner_db"].result}@${local.db_host}:5432/telus?${local.pg_tls}"
    BACKUP_DB_URL                = "postgres://telus_backup:${random_password.gen["backup_db"].result}@${local.db_host}:5432/telus?${local.pg_tls}"
    REDIS_URL                    = local.redis
    SESSION_SECRET               = random_password.gen["session"].result
    REALTIME_TICKET_SECRET       = random_password.gen["realtime_ticket"].result
    OIDC_CLIENT_SECRET           = random_password.gen["oidc_web"].result
    KEYCLOAK_ADMIN_CLIENT_SECRET = random_password.gen["kc_api_admin"].result
    METRICS_TOKEN                = random_password.gen["metrics"].result
    CLIENT_IP_FORWARD_SECRET     = random_password.gen["client_ip_forward"].result
    KC_DB_PASSWORD               = random_password.gen["keycloak_db"].result
    KC_BOOTSTRAP_ADMIN_PASSWORD  = random_password.gen["kc_bootstrap"].result
    OWNER_PASSWORD               = random_password.gen["owner_db"].result
    APP_PASSWORD                 = random_password.gen["app_db"].result
    BACKUP_PASSWORD              = random_password.gen["backup_db"].result
    KEYCLOAK_PASSWORD            = random_password.gen["keycloak_db"].result
  }
}

resource "aws_secretsmanager_secret" "app" {
  #checkov:skip=CKV2_AWS_57:Rotated by `terraform apply -replace=random_password.gen[...]` + bootstrap task (documented in infra/aws/README.md).
  name       = "${local.name}/app"
  kms_key_id = aws_kms_key.main.arn
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode(local.app_secret)
}

# Set once by hand (Stripe dashboard, mail provider); Terraform creates the empty container and never overwrites it.
resource "aws_secretsmanager_secret" "external" {
  #checkov:skip=CKV2_AWS_57:Third-party credentials (Stripe, SMTP) are rotated at the provider.
  name       = "${local.name}/external"
  kms_key_id = aws_kms_key.main.arn
}

resource "aws_secretsmanager_secret_version" "external" {
  secret_id     = aws_secretsmanager_secret.external.id
  secret_string = jsonencode({ STRIPE_SECRET_KEY = "", STRIPE_WEBHOOK_SECRET = "", SMTP_URL = "" })
  lifecycle { ignore_changes = [secret_string] }
}
