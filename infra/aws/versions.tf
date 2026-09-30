terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # State in S3 with locking; the bucket/key come from envs/<env>.backend.hcl:
  #   terraform init -backend-config=envs/staging.backend.hcl
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "telus-auction", Environment = var.env, ManagedBy = "terraform" }
  }
}
