# Access logs: ALB requests and S3 access to the audit/backups buckets land in one log bucket (SSE-S3 — ALB log delivery
# does not support KMS). WAF decisions go to CloudWatch.
resource "aws_s3_bucket" "logs" {
  bucket        = "${local.name}-logs-${data.aws_caller_identity.current.account_id}"
  force_destroy = false
  #checkov:skip=CKV_AWS_144:Data residency — logs stay in the UAE region; no cross-region copy.
  #checkov:skip=CKV_AWS_145:ALB access-log delivery supports only SSE-S3, not KMS.
  #checkov:skip=CKV_AWS_18:This is the access-log destination itself.
  #checkov:skip=CKV2_AWS_62:No consumers for object events on log files.
  #checkov:skip=CKV_AWS_21:Log objects are write-once by nature; versioning adds cost, not safety.
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration { days = var.sizes.log_retention_days }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "AlbLogDelivery", Effect = "Allow", Principal = { Service = "logdelivery.elasticloadbalancing.amazonaws.com" },
      Action = "s3:PutObject", Resource = "${aws_s3_bucket.logs.arn}/alb/AWSLogs/${data.aws_caller_identity.current.account_id}/*" },
      { Sid      = "S3AccessLogs", Effect = "Allow", Principal = { Service = "logging.s3.amazonaws.com" }, Action = "s3:PutObject",
        Resource = "${aws_s3_bucket.logs.arn}/s3/*",
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } } },
      { Sid = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*",
      Resource = [aws_s3_bucket.logs.arn, "${aws_s3_bucket.logs.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } },
    ]
  })
}

resource "aws_s3_bucket_logging" "locked" {
  for_each      = local.locked_buckets
  bucket        = each.value.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3/${each.key}/"
}

resource "aws_cloudwatch_log_group" "waf" {
  #checkov:skip=CKV_AWS_338:365 days in production (var.sizes.log_retention_days); staging keeps 30.
  name              = "aws-waf-logs-${local.name}" # WAF requires this prefix
  retention_in_days = var.sizes.log_retention_days
  kms_key_id        = aws_kms_key.main.arn
}

resource "aws_wafv2_web_acl_logging_configuration" "main" {
  resource_arn            = aws_wafv2_web_acl.main.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]
  redacted_fields {
    single_header { name = "authorization" }
  }
  redacted_fields {
    single_header { name = "cookie" }
  }
}

# The VPC's default security group allows nothing (every resource here uses its own group).
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
}

# Enhanced monitoring (OS-level metrics) for the database.
resource "aws_iam_role" "rds_monitoring" {
  name = "${local.name}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "monitoring.rds.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}
