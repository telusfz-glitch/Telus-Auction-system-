# `terraform test` — plans both environments against a mocked AWS provider (no credentials, nothing created) and checks
# the properties that matter: private data tier, encryption, locks, least-privilege routing, production sizing.
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["me-central-1a", "me-central-1b", "me-central-1c"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_db_instance" {
    defaults = {
      address            = "telus.example.me-central-1.rds.amazonaws.com"
      master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:me-central-1:123456789012:secret:rds-master", kms_key_id = "k", secret_status = "active" }]
    }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:me-central-1:123456789012:key/mock" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:me-central-1:123456789012:secret:mock" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = {
      arn                  = "arn:aws:ecs:me-central-1:123456789012:task-definition/mock:1"
      arn_without_revision = "arn:aws:ecs:me-central-1:123456789012:task-definition/mock"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:me-central-1:123456789012:cluster/mock" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:me-central-1:123456789012:mock" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:me-central-1:123456789012:log-group:mock" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:me-central-1:123456789012:loadbalancer/app/mock/1", arn_suffix = "app/mock/1", dns_name = "mock.elb.amazonaws.com" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:me-central-1:123456789012:targetgroup/mock/1", arn_suffix = "targetgroup/mock/1" }
  }
  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:me-central-1:123456789012:regional/webacl/mock/1" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { repository_url = "123456789012.dkr.ecr.me-central-1.amazonaws.com/telus/mock" }
  }
}

mock_provider "random" {}

variables {
  certificate_arn = "arn:aws:acm:me-central-1:123456789012:certificate/mock"
  image_tag       = "abc1234"
  alarm_email     = "ops@example.test"
}

run "staging_plans" {
  command = plan
  variables {
    env        = "staging"
    app_domain = "staging.auction.example"
    api_domain = "api.staging.auction.example"
    id_domain  = "id.staging.auction.example"
  }
  assert {
    condition     = aws_db_instance.main.publicly_accessible == false && aws_db_instance.main.storage_encrypted
    error_message = "the database must be private and encrypted"
  }
  assert {
    condition     = aws_elasticache_replication_group.main.transit_encryption_enabled && aws_elasticache_replication_group.main.at_rest_encryption_enabled
    error_message = "Redis must be encrypted in transit and at rest"
  }
  assert {
    condition     = aws_s3_bucket_object_lock_configuration.audit.rule[0].default_retention[0].mode == "COMPLIANCE"
    error_message = "the audit bucket must use COMPLIANCE object lock"
  }
  assert {
    condition     = alltrue([for s in aws_ecs_service.svc : s.network_configuration[0].assign_public_ip == false])
    error_message = "no task may get a public IP"
  }
  assert {
    condition     = length(aws_lb_listener_rule.kc_admin_allowed) == 0 && aws_lb_listener_rule.kc_admin_blocked.action[0].fixed_response[0].status_code == "403"
    error_message = "without admin_cidrs the Keycloak admin console must be blocked"
  }
  assert {
    condition     = aws_lb_listener_rule.api_metrics_blocked.action[0].fixed_response[0].status_code == "404"
    error_message = "/metrics must not be served publicly"
  }
  assert {
    condition     = aws_db_instance.main.multi_az == false && length(aws_nat_gateway.main) == 1
    error_message = "staging uses the small footprint"
  }
  assert {
    condition     = aws_lb.main.access_logs[0].enabled && aws_lb.main.access_logs[0].prefix == "alb"
    error_message = "ALB access logs are on"
  }
  assert {
    condition     = startswith(aws_cloudwatch_log_group.waf.name, "aws-waf-logs-") && length(aws_wafv2_web_acl_logging_configuration.main.redacted_fields) == 2
    error_message = "WAF logs go to CloudWatch with credentials (authorization, cookie) redacted"
  }
  assert {
    condition     = strcontains(aws_kms_key.main.policy, "events.amazonaws.com") && strcontains(aws_kms_key.main.policy, "cloudwatch.amazonaws.com")
    error_message = "alarm publishers must be able to use the key that encrypts the alarm topic"
  }
}

run "production_plans" {
  command = plan
  variables {
    env         = "production"
    app_domain  = "auction.example"
    api_domain  = "api.auction.example"
    id_domain   = "id.auction.example"
    admin_cidrs = ["203.0.113.10/32"]
    sizes = {
      multi_az        = true, nat_gateways = 2, db_instance_class = "db.m7g.large", db_storage_gb = 200, db_backup_days = 35,
      redis_node_type = "cache.m7g.large", redis_replicas = 1, api_count = 3, web_count = 2, keycloak_count = 2,
      api_cpu         = 1024, api_memory = 2048, log_retention_days = 365, audit_retention_days = 2557, backup_lock_days = 35
    }
  }
  assert {
    condition     = aws_db_instance.main.multi_az && aws_db_instance.main.deletion_protection && aws_db_instance.main.backup_retention_period == 35
    error_message = "production database: Multi-AZ, deletion protection, 35-day point-in-time recovery"
  }
  assert {
    condition     = aws_elasticache_replication_group.main.automatic_failover_enabled && aws_lb.main.enable_deletion_protection
    error_message = "production: Redis failover and ALB deletion protection"
  }
  assert {
    condition     = length(aws_lb_listener_rule.kc_admin_allowed) == 1
    error_message = "admin_cidrs opens the Keycloak admin console to those networks only"
  }
  assert {
    condition     = aws_ecs_service.svc["api"].desired_count == 3 && aws_ecs_service.svc["keycloak"].desired_count == 2
    error_message = "production capacity"
  }
}
