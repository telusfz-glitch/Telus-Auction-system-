resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "svc" {
  #checkov:skip=CKV_AWS_338:365 days in production (var.sizes.log_retention_days); staging keeps 30.
  for_each          = toset(["api", "web", "keycloak", "ops"])
  name              = "/telus/${var.env}/${each.key}"
  retention_in_days = var.sizes.log_retention_days
  kms_key_id        = aws_kms_key.main.arn
}

locals {
  repo     = { for k, r in aws_ecr_repository.repo : k => "${r.repository_url}:${var.image_tag}" }
  app_arn  = aws_secretsmanager_secret.app.arn
  ext_arn  = aws_secretsmanager_secret.external.arn
  secret   = { for k in keys(local.app_secret) : k => "${local.app_arn}:${k}::" }
  external = { for k in ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "SMTP_URL"] : k => "${local.ext_arn}:${k}::" }
  issuer   = "https://${var.id_domain}/realms/telus"
  log = { for k, g in aws_cloudwatch_log_group.svc : k => {
    logDriver = "awslogs"
    options   = { "awslogs-group" = g.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = k }
  } }
  env_list    = { for name, e in local.envs : name => [for k, v in e : { name = k, value = tostring(v) }] }
  secret_list = { for name, s in local.secrets : name => [for k, v in s : { name = k, valueFrom = v }] }

  envs = {
    api = {
      NODE_ENV                  = "production", PORT = 4000, TRUST_PROXY = 1, KEYCLOAK_ISSUER = local.issuer, API_AUDIENCE = "telus-api",
      CORS_ORIGINS              = "https://${var.app_domain}", PUBLIC_WEB_URL = "https://${var.app_domain}", MAIL_FROM = var.mail_from,
      DISPLAY_TIMEZONE          = "Asia/Dubai", AUDIT_SHIP_BUCKET = aws_s3_bucket.audit.bucket, AUDIT_SHIP_REGION = var.region,
      AUDIT_SHIP_RETENTION_DAYS = var.env == "production" ? 2557 : 30, METRICS_EMF_NAMESPACE = local.metrics_namespace,
    }
    web = {
      NODE_ENV = "production", WEB_URL = "https://${var.app_domain}", OIDC_ISSUER = local.issuer, OIDC_CLIENT_ID = "telus-web",
      API_URL  = "https://${var.api_domain}", API_PUBLIC_URL = "https://${var.api_domain}", DISPLAY_TIMEZONE = "Asia/Dubai",
    }
    keycloak = {
      KC_DB_URL       = "jdbc:postgresql://${local.db_host}:5432/keycloak?sslmode=verify-full&sslrootcert=/opt/keycloak/rds-ca.pem"
      KC_DB_USERNAME  = "keycloak", KC_HOSTNAME = "https://${var.id_domain}", KC_PROXY_HEADERS = "xforwarded",
      KC_HTTP_ENABLED = "true", KC_HEALTH_ENABLED = "true", KC_BOOTSTRAP_ADMIN_USERNAME = "kcbootstrap",
      TELUS_WEB_URL   = "https://${var.app_domain}", JAVA_OPTS_KC_HEAP = "-XX:MaxRAMPercentage=70",
    }
    migrate   = { NODE_ENV = "production" }
    bootstrap = { ADMIN_URL = "postgres://${aws_db_instance.main.username}@${local.db_host}:5432/postgres?sslmode=verify-full&sslrootcert=/app/rds-ca.pem" }
    backup    = { BACKUP_S3_URI = "s3://${aws_s3_bucket.backups.bucket}/daily/" }
    drill     = { DRILL_S3_URI = "s3://${aws_s3_bucket.backups.bucket}/daily/", DRILL_MAX_AGE_HOURS = 36 }
    verify    = { NODE_ENV = "production", AUDIT_SHIP_BUCKET = aws_s3_bucket.audit.bucket, AUDIT_SHIP_REGION = var.region, KEYCLOAK_ISSUER = local.issuer }
  }
  secrets = {
    api = merge({ for k in ["DATABASE_URL", "REDIS_URL", "REALTIME_TICKET_SECRET", "KEYCLOAK_ADMIN_CLIENT_SECRET", "METRICS_TOKEN", "CLIENT_IP_FORWARD_SECRET"] : k => local.secret[k] }, local.external)
    web = { for k in ["REDIS_URL", "SESSION_SECRET", "OIDC_CLIENT_SECRET", "CLIENT_IP_FORWARD_SECRET"] : k => local.secret[k] }
    keycloak = {
      KC_DB_PASSWORD                = local.secret["KC_DB_PASSWORD"]
      KC_BOOTSTRAP_ADMIN_PASSWORD   = local.secret["KC_BOOTSTRAP_ADMIN_PASSWORD"]
      TELUS_WEB_CLIENT_SECRET       = local.secret["OIDC_CLIENT_SECRET"]
      TELUS_API_ADMIN_CLIENT_SECRET = local.secret["KEYCLOAK_ADMIN_CLIENT_SECRET"]
    }
    migrate = { OWNER_DATABASE_URL = local.secret["OWNER_DATABASE_URL"] }
    bootstrap = merge({ for k in ["OWNER_PASSWORD", "APP_PASSWORD", "BACKUP_PASSWORD", "KEYCLOAK_PASSWORD"] : k => local.secret[k] },
    { PGPASSWORD = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" })
    backup = { BACKUP_DB_URL = local.secret["BACKUP_DB_URL"] }
    verify = { DATABASE_URL = local.secret["DATABASE_URL"] }
    drill  = {} # no database credentials: it restores into its own throwaway server
  }
}

# ---------------- IAM ----------------
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: pull images, write logs, read exactly these secrets.
resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"],
      Resource = [local.app_arn, local.ext_arn, aws_db_instance.main.master_user_secret[0].secret_arn] },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = [aws_kms_key.main.arn] },
    ]
  })
}

# Task roles: what the code itself may do.
resource "aws_iam_role" "task" {
  for_each           = toset(["api", "web", "keycloak", "ops"])
  name               = "${local.name}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# API: ship audit batches (put with retention, read back to verify) — never delete.
resource "aws_iam_role_policy" "api_audit" {
  role = aws_iam_role.task["api"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:PutObject", "s3:PutObjectRetention", "s3:GetObject", "s3:GetObjectRetention"], Resource = "${aws_s3_bucket.audit.arn}/*" },
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.audit.arn },
      { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = aws_kms_key.main.arn },
    ]
  })
}

# ops: write backups and read them back (monthly restore drill), read the audit copy (audit:verify) — never delete either.
resource "aws_iam_role_policy" "ops" {
  role = aws_iam_role.task["ops"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"], Resource = "${aws_s3_bucket.backups.arn}/*" },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectRetention"], Resource = "${aws_s3_bucket.audit.arn}/*" },
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = [aws_s3_bucket.audit.arn, aws_s3_bucket.backups.arn] },
      { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = aws_kms_key.main.arn },
    ]
  })
}

# ---------------- Task definitions ----------------
locals {
  tasks = {
    api       = { image = local.repo["api"], cpu = var.sizes.api_cpu, memory = var.sizes.api_memory, role = "api", log = "api", ports = [4000], command = null }
    web       = { image = local.repo["web"], cpu = 512, memory = 1024, role = "web", log = "web", ports = [3000], command = null }
    keycloak  = { image = local.repo["keycloak"], cpu = 1024, memory = 2048, role = "keycloak", log = "keycloak", ports = [8080, 9000], command = null }
    migrate   = { image = local.repo["api"], cpu = 256, memory = 512, role = "ops", log = "ops", ports = [], command = ["node", "apps/api/dist/db/migrate.js"] }
    bootstrap = { image = local.repo["ops"], cpu = 256, memory = 512, role = "ops", log = "ops", ports = [], command = ["scripts/db/bootstrap-roles.sh"] }
    backup    = { image = local.repo["ops"], cpu = 512, memory = 1024, role = "ops", log = "ops", ports = [], command = ["scripts/db/backup.sh", "/tmp"] }
    verify    = { image = local.repo["api"], cpu = 256, memory = 512, role = "ops", log = "ops", ports = [], command = ["node", "apps/api/dist/audit/verify-cli.js"] }
    # Restores the newest backup into a throwaway PostgreSQL inside the task: room for the dump and the restored copy.
    drill = { image = local.repo["ops"], cpu = 1024, memory = 4096, role = "ops", log = "ops", ports = [], command = ["scripts/db/scheduled-drill.sh"], storage = var.sizes.drill_storage_gib }
  }
}

resource "aws_ecs_task_definition" "task" {
  for_each                 = local.tasks
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task[each.value.role].arn
  dynamic "ephemeral_storage" {
    for_each = try(each.value.storage, null) == null ? [] : [each.value.storage]
    content { size_in_gib = ephemeral_storage.value }
  }
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([merge({
    name             = each.key
    image            = each.value.image
    essential        = true
    environment      = local.env_list[each.key]
    secrets          = local.secret_list[each.key]
    portMappings     = [for p in each.value.ports : { containerPort = p, protocol = "tcp" }]
    logConfiguration = local.log[each.value.log]
    linuxParameters  = { initProcessEnabled = true }
  }, each.value.command == null ? {} : { command = each.value.command })])
}

# ---------------- Long-running services ----------------
locals {
  services_run = {
    api      = { count = var.sizes.api_count, port = 4000 }
    web      = { count = var.sizes.web_count, port = 3000 }
    keycloak = { count = var.sizes.keycloak_count, port = 8080 }
  }
}

resource "aws_ecs_service" "svc" {
  for_each                           = local.services_run
  name                               = each.key
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.task[each.key].arn
  desired_count                      = each.value.count
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = each.key == "keycloak" ? 180 : 60
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.svc[each.key].id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.svc[each.key].arn
    container_name   = each.key
    container_port   = each.value.port
  }
  depends_on = [aws_lb_listener.https]
}
