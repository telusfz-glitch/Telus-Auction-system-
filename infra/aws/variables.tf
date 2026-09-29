variable "env" {
  description = "staging or production"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.env)
    error_message = "env must be staging or production."
  }
}

variable "region" {
  description = "AWS region. Default: Middle East (UAE) — customer data stays in-country."
  type        = string
  default     = "me-central-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "app_domain" {
  description = "Public hostname of the web app, e.g. auction.telus.ae"
  type        = string
}

variable "api_domain" {
  description = "Public hostname of the API (sockets + payment webhooks), e.g. api.auction.telus.ae"
  type        = string
}

variable "id_domain" {
  description = "Public hostname of Keycloak, e.g. id.auction.telus.ae"
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate (in var.region) covering the three hostnames. DNS records point at the ALB (output alb_dns_name)."
  type        = string
}

variable "image_tag" {
  description = "Image tag (the git commit SHA) deployed for api, web, ops and keycloak."
  type        = string
}

variable "alarm_email" {
  description = "Receives CloudWatch alarms (confirm the SNS subscription email)."
  type        = string
}

variable "mail_from" {
  type    = string
  default = "TELUS Auctions <no-reply@auctions.telus.ae>"
}

variable "sizes" {
  description = "Per-environment capacity. Defaults suit staging; see envs/production.tfvars."
  type = object({
    multi_az             = bool
    nat_gateways         = number
    db_instance_class    = string
    db_storage_gb        = number
    db_backup_days       = number
    redis_node_type      = string
    redis_replicas       = number
    api_count            = number
    web_count            = number
    keycloak_count       = number
    api_cpu              = number
    api_memory           = number
    log_retention_days   = number
    audit_retention_days = number
    backup_lock_days     = number
  })
  default = {
    multi_az             = false
    nat_gateways         = 1
    db_instance_class    = "db.t4g.medium"
    db_storage_gb        = 50
    db_backup_days       = 7
    redis_node_type      = "cache.t4g.small"
    redis_replicas       = 0
    api_count            = 2
    web_count            = 2
    keycloak_count       = 1
    api_cpu              = 512
    api_memory           = 1024
    log_retention_days   = 30
    audit_retention_days = 30
    backup_lock_days     = 7
  }
}

variable "admin_cidrs" {
  description = "Networks allowed to open the Keycloak admin console (/admin). Empty = blocked from the internet."
  type        = list(string)
  default     = []
}
