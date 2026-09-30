# AWS deployment (Terraform)

One Terraform root, two environments (`envs/staging.tfvars`, `envs/production.tfvars`), region **me-central-1 (UAE)** by
default so customer data stays in-country.

## What it creates
| Layer | Resources |
|---|---|
| Network | VPC over 2 zones; public subnets (ALB, NAT) and private subnets (everything else); VPC flow logs; the default security group allows nothing |
| Edge | ALB with TLS 1.2+ (ACM certificate), port 80 → HTTPS redirect, host routing for `app_domain` / `api_domain` / `id_domain`; `/metrics` returns 404 publicly; the Keycloak admin console answers only to `admin_cidrs` (blocked when empty); WAF (AWS common and known-bad-inputs rule sets + a per-IP rate limit of 3,000 requests / 5 min), WAF logs with `authorization` and `cookie` redacted; ALB access logs |
| Compute | ECS Fargate: `api`, `web`, `keycloak` services (private, no public IPs); one-off tasks `bootstrap`, `migrate`; scheduled `backup` (nightly), `verify` (hourly audit-trail check) and `drill` (monthly restore drill, below) |
| Data | RDS PostgreSQL 16 (encrypted, private, TLS enforced, point-in-time recovery, enhanced monitoring; Multi-AZ in production); ElastiCache Redis 7 (TLS + AUTH, encrypted; failover in production) |
| Storage | S3 audit bucket (Object Lock **COMPLIANCE**, `audit_retention_days`), S3 backups bucket (Object Lock, `backup_lock_days`), access-log bucket; all public access blocked, TLS-only |
| Secrets | Secrets Manager: generated secrets (`app`) and third-party ones you fill in (`external`: Stripe, SMTP); one KMS key for everything at rest, rotation on |
| Alerts | SNS e-mail (`alarm_email`): ALB 5xx, database CPU/storage, Redis CPU, unhealthy targets, any one-off/scheduled task that exits non-zero |

## First deployment, in order
1. **State bucket.** Create an S3 bucket (versioning on) for Terraform state, copy `envs/example.backend.hcl` to
   `envs/<env>.backend.hcl` (git-ignored), fill it in, then `terraform init -backend-config=envs/<env>.backend.hcl`.
2. **Certificate.** Request one ACM certificate in `me-central-1` covering the three hostnames, validate it by DNS.
3. **Variables.** In `envs/<env>.tfvars` set `certificate_arn`, `alarm_email`, and (production) `admin_cidrs` — the office/VPN
   addresses allowed to open the Keycloak admin console.
4. **Registries first**, so images can be pushed before services start:
   `terraform apply -var-file=envs/<env>.tfvars -var image_tag=<git sha> -target=aws_ecr_repository.repo`
5. **Build and push the four images** from the repository root, tagged with the same git SHA
   (`terraform output ecr_repositories` lists the URLs):
   ```sh
   docker build -f apps/api/Dockerfile --target runtime -t <api-repo>:<sha> .
   docker build -f apps/api/Dockerfile --target ops     -t <ops-repo>:<sha> .
   docker build -f apps/web/Dockerfile                  -t <web-repo>:<sha> .
   docker build -f infra/keycloak/Dockerfile            -t <keycloak-repo>:<sha> .
   docker push …   # all four
   ```
6. **Everything else:** `terraform apply -var-file=envs/<env>.tfvars -var image_tag=<sha>`. Confirm the SNS e-mail subscription.
   Services will restart until steps 7–8 are done; that is expected.
7. **Database roles** (once; re-running rotates the passwords to the current secrets) — creates the non-superuser owner
   `telus_owner`, the runtime role `telus_app` (row-level security always applies), `telus_backup` and `keycloak`:
   ```sh
   aws ecs run-task --cluster $(terraform output -raw cluster) --launch-type FARGATE \
     --task-definition telus-<env>-bootstrap \
     --network-configuration "awsvpcConfiguration={subnets=[<private subnets>],securityGroups=[$(terraform output -raw ops_security_group)]}"
   ```
   (`terraform output private_subnets` lists the subnets.)
8. **Migrations:** the same command with `--task-definition telus-<env>-migrate`. Run it again on every release that adds a
   file under `apps/api/src/db/migrations`, **before** updating the services.
9. **Third-party secrets:** put `{"STRIPE_SECRET_KEY": "…", "STRIPE_WEBHOOK_SECRET": "…", "SMTP_URL": "smtps://…"}` into the
   secret named by `terraform output external_secret_arn`, then
   `aws ecs update-service --force-new-deployment` for `api`.
10. **Stripe:** add a webhook endpoint at `terraform output stripe_webhook_url` for `checkout.session.completed`,
    `checkout.session.async_payment_succeeded`, `checkout.session.expired` and `checkout.session.async_payment_failed`; its signing secret is `STRIPE_WEBHOOK_SECRET`.
11. **DNS:** point the three hostnames (alias/CNAME) at `terraform output alb_dns_name`.
12. **First staff user:** sign in to `https://<id_domain>/admin` from an `admin_cidrs` address with the bootstrap admin (password
    in the `app` secret, `KC_BOOTSTRAP_ADMIN_PASSWORD`), create a permanent administrator, give the first staff user
    `super_admin`, then delete the bootstrap admin. The staff user is made to enrol an authenticator app on first sign-in.

## Releases
Build and push the four images with the new SHA, run `migrate` (step 8) if there are new migrations, then
`terraform apply -var image_tag=<new sha>`. ECS rolls the services one task at a time behind the ALB health checks
(`/health/ready` for the API).

## Monthly restore drill
On the 1st of each month at 02:00 UTC the `drill` task downloads the newest backup from the backups bucket, starts a
throwaway PostgreSQL 16 inside the task (never production, gone when the task ends), restores the backup into it and
runs every check of `scripts/db/restore-drill.sh`: checksum, all migrations, audit hash chain, prices equal the bid
ledger, invoice totals, row-level security, append-only triggers. It also fails when the newest backup is more than 36
hours old, so a nightly backup that silently stopped is caught. Any failure sends the "task failed" alarm e-mail; the
output is in the `/telus/<env>/ops` log group. Run it on demand with the same `aws ecs run-task` command as step 7 and
`--task-definition telus-<env>-drill`. Task disk: `sizes.drill_storage_gib` (30 GiB staging, 100 GiB production;
raise it as the database grows, up to 200). Backups encrypted with `BACKUP_GPG_RECIPIENT` are not drilled here (the task
has no private key); in AWS the bucket's KMS encryption is used instead.

## Rotating generated secrets
`terraform apply -replace='random_password.gen["app_db"]'` (or `owner_db`, `backup_db`, …) writes a new value to the `app` secret,
then run the `bootstrap` task (step 7) so the database role gets it, then force a new deployment of the services. Third-party
credentials (`external` secret) are rotated at the provider and pasted in again.

## Checks run on this code
`terraform fmt -check`, `terraform validate`, `terraform test` (plans both environments against a mocked AWS provider and checks
the properties above: private and encrypted data tier, COMPLIANCE lock, no public task IPs, admin console blocked by default,
`/metrics` not public, access and WAF logs, alarm delivery, production sizing) and Checkov: 0 failed checks; every skipped
check carries its reason next to the resource (`#checkov:skip=…`).

Not yet done: an actual `terraform apply` in an AWS account. The first staging deployment is where that gets proven.
