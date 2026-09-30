# Least privilege between tiers: only the ALB is reachable from the internet; each service accepts only its callers.
resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public HTTPS"
  vpc_id      = aws_vpc.main.id
}
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS"
}
resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  #checkov:skip=CKV_AWS_260:Port 80 only answers with a redirect to HTTPS.
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "HTTP, redirected to HTTPS"
}
resource "aws_vpc_security_group_egress_rule" "alb_to_vpc" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 3000
  to_port           = 9000
  description       = "To services (web 3000, api 4000, keycloak 8080/9000)"
}

locals {
  # name => ports the ALB may reach
  services = { web = [3000], api = [4000], keycloak = [8080, 9000], ops = [] }
}

resource "aws_security_group" "svc" {
  #checkov:skip=CKV2_AWS_5:Attached to the ECS services and scheduled tasks (for_each references Checkov cannot resolve).
  for_each    = local.services
  name        = "${local.name}-${each.key}"
  description = "${each.key} tasks"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "from_alb" {
  for_each                     = { for p in flatten([for s, ports in local.services : [for port in ports : { s = s, port = port }]]) : "${p.s}-${p.port}" => p }
  security_group_id            = aws_security_group.svc[each.value.s].id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  description                  = "From the ALB"
}

# Tasks call AWS APIs, Stripe, SMTP and each other's public hostnames over HTTPS, and the data tier.
resource "aws_vpc_security_group_egress_rule" "svc_out" {
  for_each          = local.services
  security_group_id = aws_security_group.svc[each.key].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Outbound (HTTPS to AWS/Stripe/SMTP via NAT, data tier inside the VPC)"
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "PostgreSQL"
  vpc_id      = aws_vpc.main.id
}
resource "aws_vpc_security_group_ingress_rule" "db" {
  for_each                     = toset(["api", "keycloak", "ops"])
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.svc[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from ${each.key}"
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "Redis"
  vpc_id      = aws_vpc.main.id
}
resource "aws_vpc_security_group_ingress_rule" "redis" {
  for_each                     = toset(["api", "web"])
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.svc[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  description                  = "Redis from ${each.key}"
}
