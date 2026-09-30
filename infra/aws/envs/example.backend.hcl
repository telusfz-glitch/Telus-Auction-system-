# Copy to <env>.backend.hcl. The state bucket and lock table are created once, outside this configuration.
bucket       = "telus-terraform-state-<account-id>"
key          = "telus-auction/<env>.tfstate"
region       = "me-central-1"
encrypt      = true
use_lockfile = true
