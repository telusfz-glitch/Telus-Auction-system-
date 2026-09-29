resource "aws_lb" "main" {
  name                       = local.name
  load_balancer_type         = "application"
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  idle_timeout               = 120 # Socket.IO pings every 20 s
  enable_deletion_protection = var.env == "production"
  access_logs {
    bucket  = aws_s3_bucket.logs.id
    prefix  = "alb"
    enabled = true
  }
  #checkov:skip=CKV2_AWS_76:Log4j (Log4JRCE) is covered by AWSManagedRulesKnownBadInputsRuleSet on the attached web ACL.
  #checkov:skip=CKV_AWS_150:Deletion protection is on in production (var.env); staging must be destroyable.
}

resource "aws_lb_target_group" "svc" {
  for_each = {
    web      = { port = 3000, health_port = "3000", path = "/" }
    api      = { port = 4000, health_port = "4000", path = "/health/ready" }
    keycloak = { port = 8080, health_port = "9000", path = "/health/ready" }
  }
  name                 = "${local.name}-${each.key}"
  port                 = each.value.port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30
  #checkov:skip=CKV_AWS_378:TLS terminates at the ALB; targets are in private subnets reachable only from the ALB security group.
  health_check {
    path                = each.value.path
    port                = each.value.health_port
    matcher             = "200-399"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  #checkov:skip=CKV_AWS_2:Port 80 only redirects to HTTPS.
  #checkov:skip=CKV_AWS_103:Port 80 only redirects to HTTPS.
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

# Prometheus scrapes /metrics from inside the VPC; it is never served to the internet.
resource "aws_lb_listener_rule" "api_metrics_blocked" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
  condition {
    host_header { values = [var.api_domain] }
  }
  condition {
    path_pattern { values = ["/metrics", "/metrics/*"] }
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc["api"].arn
  }
  condition {
    host_header { values = [var.api_domain] }
  }
}

# Keycloak admin console: only from admin_cidrs (if any); otherwise refused.
resource "aws_lb_listener_rule" "kc_admin_allowed" {
  count        = length(var.admin_cidrs) > 0 ? 1 : 0
  listener_arn = aws_lb_listener.https.arn
  priority     = 30
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc["keycloak"].arn
  }
  condition {
    host_header { values = [var.id_domain] }
  }
  condition {
    path_pattern { values = ["/admin", "/admin/*"] }
  }
  condition {
    source_ip { values = var.admin_cidrs }
  }
}

resource "aws_lb_listener_rule" "kc_admin_blocked" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 31
  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
  condition {
    host_header { values = [var.id_domain] }
  }
  condition {
    path_pattern { values = ["/admin", "/admin/*"] }
  }
}

resource "aws_lb_listener_rule" "keycloak" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 40
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc["keycloak"].arn
  }
  condition {
    host_header { values = [var.id_domain] }
  }
}

resource "aws_lb_listener_rule" "web" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 50
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc["web"].arn
  }
  condition {
    host_header { values = [var.app_domain] }
  }
}

# ---------------- WAF ----------------
resource "aws_wafv2_web_acl" "main" {
  name  = local.name
  scope = "REGIONAL"
  default_action {
    allow {}
  }

  rule {
    name     = "common"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
        # Bodies above 8 KB are legitimate here (Excel lot import up to 2 MB, payment webhooks): count, do not block.
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "known-bad-inputs"
    priority = 20
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  # Floods from one address (the API also limits per signed-in user; see README step 10).
  rule {
    name     = "rate-per-ip"
    priority = 30
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 3000 # requests per 5 minutes per IP
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-rate"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.main.arn
}
