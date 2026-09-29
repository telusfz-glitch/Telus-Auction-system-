output "alb_dns_name" {
  description = "Point app_domain, api_domain and id_domain (CNAME/alias) here."
  value       = aws_lb.main.dns_name
}
output "ecr_repositories" { value = { for k, r in aws_ecr_repository.repo : k => r.repository_url } }
output "cluster" { value = aws_ecs_cluster.main.name }
output "private_subnets" { value = aws_subnet.private[*].id }
output "ops_security_group" { value = aws_security_group.svc["ops"].id }
output "database_endpoint" { value = aws_db_instance.main.address }
output "audit_bucket" { value = aws_s3_bucket.audit.bucket }
output "backups_bucket" { value = aws_s3_bucket.backups.bucket }
output "external_secret_arn" {
  description = "Fill STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and SMTP_URL here (JSON), then redeploy the api service."
  value       = aws_secretsmanager_secret.external.arn
}
output "stripe_webhook_url" { value = "https://${var.api_domain}/payments/stripe/webhook" }
