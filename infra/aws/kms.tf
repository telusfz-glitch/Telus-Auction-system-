data "aws_caller_identity" "current" {}

# One customer-managed key for this environment's data at rest (database, Redis, buckets, secrets, logs).
resource "aws_kms_key" "main" {
  description             = "${local.name} data at rest"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Account", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "kms:*", Resource = "*" },
      {
        Sid       = "CloudWatchLogs", Effect = "Allow", Principal = { Service = "logs.${var.region}.amazonaws.com" },
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"], Resource = "*",
        Condition = { ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:*" } }
      },
      # Alarms and EventBridge publish to the CMK-encrypted SNS topic; without this they are dropped silently.
      {
        Sid    = "AlarmPublishers", Effect = "Allow", Principal = { Service = ["cloudwatch.amazonaws.com", "events.amazonaws.com"] },
        Action = ["kms:Decrypt", "kms:GenerateDataKey*"], Resource = "*"
      },
    ]
  })
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.main.key_id
}
