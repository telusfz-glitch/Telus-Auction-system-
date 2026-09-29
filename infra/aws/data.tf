# ---------------- PostgreSQL 16 ----------------
resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${local.name}-pg16"
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # log statements slower than 1 s
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
}

resource "aws_db_instance" "main" {
  identifier                          = local.name
  engine                              = "postgres"
  engine_version                      = "16"
  instance_class                      = var.sizes.db_instance_class
  allocated_storage                   = var.sizes.db_storage_gb
  max_allocated_storage               = var.sizes.db_storage_gb * 4
  storage_type                        = "gp3"
  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.main.arn
  db_name                             = "postgres"
  username                            = "telus_admin"
  manage_master_user_password         = true # in Secrets Manager, rotated by RDS; used only by the bootstrap task
  master_user_secret_kms_key_id       = aws_kms_key.main.arn
  db_subnet_group_name                = aws_db_subnet_group.main.name
  vpc_security_group_ids              = [aws_security_group.db.id]
  parameter_group_name                = aws_db_parameter_group.pg16.name
  multi_az                            = var.sizes.multi_az
  publicly_accessible                 = false
  backup_retention_period             = var.sizes.db_backup_days # point-in-time recovery window
  backup_window                       = "22:00-23:00"            # 02:00-03:00 Gulf time
  maintenance_window                  = "Fri:23:30-Sat:00:30"
  copy_tags_to_snapshot               = true
  deletion_protection                 = var.env == "production"
  skip_final_snapshot                 = var.env != "production"
  final_snapshot_identifier           = var.env == "production" ? "${local.name}-final" : null
  performance_insights_enabled        = true
  performance_insights_kms_key_id     = aws_kms_key.main.arn
  enabled_cloudwatch_logs_exports     = ["postgresql"]
  auto_minor_version_upgrade          = true
  iam_database_authentication_enabled = false
  monitoring_interval                 = 60
  monitoring_role_arn                 = aws_iam_role.rds_monitoring.arn
  #checkov:skip=CKV_AWS_157:Multi-AZ is on in production (var.sizes.multi_az); staging is single-AZ by design.
  #checkov:skip=CKV_AWS_293:Deletion protection is on in production; staging must be destroyable.
  #checkov:skip=CKV_AWS_161:Password logins per role (least privilege, RLS); credentials in Secrets Manager.
}

# ---------------- Redis 7 (sessions, rate limits, socket fan-out) ----------------
resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "random_password" "redis_auth" {
  length  = 48
  special = false
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = local.name
  description                = "${local.name} sessions, rate limits, realtime"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.sizes.redis_node_type
  num_cache_clusters         = 1 + var.sizes.redis_replicas
  automatic_failover_enabled = var.sizes.redis_replicas > 0
  multi_az_enabled           = var.sizes.redis_replicas > 0
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.main.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result
  snapshot_retention_limit   = var.env == "production" ? 3 : 0
  port                       = 6379
  #checkov:skip=CKV2_AWS_50:Automatic failover is on in production (redis_replicas > 0); staging has one node.
}

# ---------------- S3: audit copy (Object Lock COMPLIANCE) and backups ----------------
resource "aws_s3_bucket" "audit" {
  #checkov:skip=CKV_AWS_144:Data residency — the audit copy stays in the UAE region.
  #checkov:skip=CKV2_AWS_62:No consumers for object events; audit:verify reads the bucket on a schedule.
  bucket              = "${local.name}-audit-${data.aws_caller_identity.current.account_id}"
  object_lock_enabled = true
  force_destroy       = false
}

resource "aws_s3_bucket" "backups" {
  #checkov:skip=CKV_AWS_144:Data residency — backups stay in the UAE region (RDS snapshots can be copied deliberately).
  #checkov:skip=CKV2_AWS_62:No consumers for object events.
  bucket              = "${local.name}-backups-${data.aws_caller_identity.current.account_id}"
  object_lock_enabled = true
  force_destroy       = false
}

locals { locked_buckets = { audit = aws_s3_bucket.audit, backups = aws_s3_bucket.backups } }

resource "aws_s3_bucket_versioning" "locked" {
  for_each = local.locked_buckets
  bucket   = each.value.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "locked" {
  for_each                = local.locked_buckets
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "locked" {
  for_each = local.locked_buckets
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

# The API sets per-object COMPLIANCE retention for audit batches itself (AUDIT_SHIP_RETENTION_DAYS); the bucket default is
# a floor. Backups get GOVERNANCE (an administrator with explicit bypass permission can remove a bad backup).
resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.sizes.audit_retention_days
    }
  }
}

resource "aws_s3_bucket_object_lock_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = var.sizes.backup_lock_days
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "expire-old-dumps"
    status = "Enabled"
    filter {}
    expiration { days = var.sizes.backup_lock_days + 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
    noncurrent_version_expiration { noncurrent_days = 7 }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    id     = "abort-incomplete-uploads" # audit objects themselves never expire here: their lock decides
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

resource "aws_s3_bucket_policy" "tls_only" {
  for_each = local.locked_buckets
  bucket   = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*",
      Resource  = [each.value.arn, "${each.value.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}
