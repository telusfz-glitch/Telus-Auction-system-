resource "aws_sns_topic" "alarms" {
  name              = "${local.name}-alarms"
  kms_master_key_id = aws_kms_key.main.id
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# SNS may deliver EventBridge events for this topic.
resource "aws_sns_topic_policy" "alarms" {
  arn = aws_sns_topic.alarms.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Owner", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "sns:*", Resource = aws_sns_topic.alarms.arn },
      { Sid = "Events", Effect = "Allow", Principal = { Service = "events.amazonaws.com" }, Action = "sns:Publish", Resource = aws_sns_topic.alarms.arn },
      { Sid = "CloudWatch", Effect = "Allow", Principal = { Service = "cloudwatch.amazonaws.com" }, Action = "sns:Publish", Resource = aws_sns_topic.alarms.arn },
    ]
  })
}

locals {
  alarms = {
    alb_5xx = {
      namespace = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", stat = "Sum", threshold = 20, op = "GreaterThanThreshold",
      dims      = { LoadBalancer = aws_lb.main.arn_suffix }, desc = "More than 20 server errors in 5 minutes"
    }
    rds_cpu = {
      namespace = "AWS/RDS", metric = "CPUUtilization", stat = "Average", threshold = 80, op = "GreaterThanThreshold",
      dims      = { DBInstanceIdentifier = aws_db_instance.main.identifier }, desc = "Database CPU above 80%"
    }
    rds_storage = {
      namespace = "AWS/RDS", metric = "FreeStorageSpace", stat = "Minimum", threshold = 10 * 1024 * 1024 * 1024, op = "LessThanThreshold",
      dims      = { DBInstanceIdentifier = aws_db_instance.main.identifier }, desc = "Database free storage below 10 GB"
    }
    redis_cpu = {
      namespace = "AWS/ElastiCache", metric = "EngineCPUUtilization", stat = "Average", threshold = 80, op = "GreaterThanThreshold",
      dims      = { ReplicationGroupId = aws_elasticache_replication_group.main.id }, desc = "Redis CPU above 80%"
    }
  }
  unhealthy_tgs = { for k, tg in aws_lb_target_group.svc : k => tg.arn_suffix }
}

resource "aws_cloudwatch_metric_alarm" "main" {
  for_each            = local.alarms
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = each.value.desc
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.stat
  dimensions          = each.value.dims
  period              = 300
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = each.value.op
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "unhealthy" {
  for_each            = local.unhealthy_tgs
  alarm_name          = "${local.name}-${each.key}-unhealthy"
  alarm_description   = "${each.key}: a target is unhealthy (readiness failing)"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  dimensions          = { TargetGroup = each.value, LoadBalancer = aws_lb.main.arn_suffix }
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# A scheduled job (backup, audit verification) or migration that exits non-zero → email. audit:verify exits 2 on
# any discrepancy between the database and its locked copy.
resource "aws_cloudwatch_event_rule" "task_failed" {
  name        = "${local.name}-task-failed"
  description = "One-off/scheduled ECS task stopped with a non-zero exit code"
  event_pattern = jsonencode({
    source        = ["aws.ecs"]
    "detail-type" = ["ECS Task State Change"]
    detail = {
      clusterArn = [aws_ecs_cluster.main.arn]
      lastStatus = ["STOPPED"]
      group      = [{ prefix = "family:" }]
      containers = { exitCode = [{ "anything-but" = 0 }] }
    }
  })
}

resource "aws_cloudwatch_event_target" "task_failed" {
  rule = aws_cloudwatch_event_rule.task_failed.name
  arn  = aws_sns_topic.alarms.arn
}
