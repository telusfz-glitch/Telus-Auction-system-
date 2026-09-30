# Scheduled jobs: nightly logical backup to the locked backups bucket, hourly audit-trail verification, and a monthly
# restore drill that proves the newest backup restores (any failure — including a backup older than 36 h — alarms).
resource "aws_iam_role" "scheduler" {
  name = "${local.name}-scheduler"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecs:RunTask"], Resource = [for k in ["backup", "verify", "drill"] : "${aws_ecs_task_definition.task[k].arn_without_revision}:*"] },
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.execution.arn, aws_iam_role.task["ops"].arn] },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = [aws_kms_key.main.arn] }, # schedules are encrypted with the CMK
    ]
  })
}

resource "aws_scheduler_schedule" "job" {
  for_each = {
    backup = "cron(30 23 * * ? *)" # 03:30 Gulf time, after the RDS backup window
    verify = "cron(15 * * * ? *)"  # hourly
    drill  = "cron(0 2 1 * ? *)"   # 1st of the month, 06:00 Gulf time, after that night's backup
  }
  name                         = "${local.name}-${each.key}"
  schedule_expression          = each.value
  schedule_expression_timezone = "UTC"
  kms_key_arn                  = aws_kms_key.main.arn
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn
    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.task[each.key].arn
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = aws_subnet.private[*].id
        security_groups  = [aws_security_group.svc["ops"].id]
        assign_public_ip = false
      }
    }
    retry_policy { maximum_retry_attempts = 1 }
  }
}
