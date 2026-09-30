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

# ---------------- Application metrics ----------------
# The API prints one CloudWatch embedded-metric-format line a minute (METRICS_EMF_NAMESPACE); CloudWatch Logs turns it
# into these metrics — no agent, no extra permissions. Names: apps/api/src/ops/metrics.service.ts (emf).
locals {
  metrics_namespace = "TELUS/${var.env}"
  app_alarms = {
    outbox_stuck = {
      metric = "OutboxOldestUnpublishedSeconds", stat = "Maximum", threshold = 60, op = "GreaterThanThreshold", missing = "notBreaching",
      desc   = "Live updates are stuck: an event has waited more than 60 s to be pushed"
    }
    email_stuck = {
      metric = "EmailOldestPendingSeconds", stat = "Maximum", threshold = 900, op = "GreaterThanThreshold", missing = "notBreaching",
      desc   = "E-mails are not going out: one has waited more than 15 minutes (check SMTP_URL)"
    }
    audit_ship_stuck = {
      metric = "AuditOldestUnshippedSeconds", stat = "Maximum", threshold = 3600, op = "GreaterThanThreshold", missing = "notBreaching",
      desc   = "Audit entries are not reaching the locked S3 copy (oldest unshipped > 1 hour)"
    }
    bid_errors = {
      metric = "BidErrors", stat = "Sum", threshold = 5, op = "GreaterThanThreshold", missing = "notBreaching",
      desc   = "More than 5 bids failed with an unexpected error in 5 minutes"
    }
    bid_latency = {
      metric = "BidLatency", stat = "p99", threshold = 1, op = "GreaterThanThreshold", missing = "notBreaching",
      desc   = "Slow bidding: 1 in 100 bids took more than 1 second (API side)"
    }
    worker_failures = {
      metric = "WorkerFailures", stat = "Sum", threshold = 10, op = "GreaterThanThreshold", missing = "notBreaching",
      desc   = "Background loops (scheduler, outbox, e-mail, audit shipping) failed more than 10 times in 5 minutes"
    }
    metrics_missing = {
      metric = "DatabaseUp", stat = "SampleCount", threshold = 1, op = "LessThanThreshold", missing = "breaching",
      desc   = "No application metrics for 15 minutes: no API instance is running, or it cannot report"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "app" {
  for_each            = local.app_alarms
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = each.value.desc
  namespace           = local.metrics_namespace
  metric_name         = each.value.metric
  statistic           = startswith(each.value.stat, "p") ? null : each.value.stat
  extended_statistic  = startswith(each.value.stat, "p") ? each.value.stat : null
  dimensions          = { Service = "api" }
  period              = 300
  evaluation_periods  = each.key == "metrics_missing" ? 3 : 1
  threshold           = each.value.threshold
  comparison_operator = each.value.op
  treat_missing_data  = each.value.missing
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = local.name
  dashboard_body = jsonencode({
    widgets = [for i, w in [
      { title = "Bids per minute", lines = [["BidsAccepted", "Sum"], ["BidsRefused", "Sum"], ["BidErrors", "Sum"]] },
      { title = "Bid time, seconds (p50 / p99)", lines = [["BidLatency", "p50"], ["BidLatency", "p99"]] },
      { title = "Live updates and e-mail: oldest waiting, seconds", lines = [["OutboxOldestUnpublishedSeconds", "Maximum"], ["EmailOldestPendingSeconds", "Maximum"]] },
      { title = "Audit copy: oldest unshipped, seconds", lines = [["AuditOldestUnshippedSeconds", "Maximum"]] },
      { title = "Auctions live / e-mails failed", lines = [["AuctionsLive", "Maximum"], ["EmailFailed", "Maximum"]] },
      { title = "Background loop failures", lines = [["WorkerFailures", "Sum"]] },
      ] : {
      type = "metric", width = 12, height = 6, x = (i % 2) * 12, y = floor(i / 2) * 6
      properties = {
        title   = w.title, region = var.region, view = "timeSeries", period = 60
        metrics = [for l in w.lines : [local.metrics_namespace, l[0], "Service", "api", { stat = l[1], label = "${l[0]} ${l[1]}" }]]
      }
    }]
  })
}
