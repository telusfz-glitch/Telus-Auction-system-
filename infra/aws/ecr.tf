# Images are pushed by CI with the commit SHA as tag (immutable), scanned on push.
resource "aws_ecr_repository" "repo" {
  for_each             = toset(["api", "ops", "web", "keycloak"])
  name                 = "telus/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.main.arn
  }
}

resource "aws_ecr_lifecycle_policy" "repo" {
  for_each   = aws_ecr_repository.repo
  repository = each.value.name
  policy = jsonencode({ rules = [{
    rulePriority = 1, description = "keep the last 50 images"
    selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 50 }
    action       = { type = "expire" }
  }] })
}
