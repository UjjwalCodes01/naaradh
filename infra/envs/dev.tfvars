# dev — shared development project. NO SECRETS IN THIS FILE (it is committed): secret values
# live in Secret Manager only (docs/runbooks/deploy.md "Secrets").
project_id = "naaradh-dev"
env        = "dev"
region     = "asia-south1"

github_repo               = "naaradh/naaradh"
github_deploy_environment = "dev"
tf_state_bucket           = "naaradh-tfstate-dev"

deletion_protection = false

hostnames = {
  api   = "api.dev.naaradh.com"
  hooks = "hooks.dev.naaradh.com"
  voice = "voice.dev.naaradh.com"
}

# Dev never places a real call and never writes to a real store.
common_env = {
  LOG_LEVEL         = "debug"
  ENGINE_DEFAULT_IN = "simulator"
  ENGINE_DEFAULT_US = "simulator"
  # The simulator is refused in production unless said so explicitly (refineEngineEnv); its
  # webhook secret is a real secret here (SIMULATOR_WEBHOOK_SECRET below), never the dev default.
  SIMULATOR_ALLOWED = "true"
  SHOPIFY_WRITEBACK = "recording"
}

# Cheapest sizes that still run every role. Workers cannot scale to zero (they are loops).
services = {
  api   = { min_instances = 0, max_instances = 2 }
  hooks = { min_instances = 0, max_instances = 2 }
  voice = { min_instances = 2, max_instances = 2 }
}

service_env = {
  # The notifications worker links to the dashboard (no web deploy in dev yet).
  "workers-notifications" = { DASHBOARD_URL = "https://app.dev.naaradh.com" }
}

redis = {
  tier           = "BASIC"
  memory_size_gb = 1
}

waf_preview = {
  api      = true
  hooks    = true
  voice    = true
  standard = true
  console  = true
}

alert_email = ""

# Audit logs (P3-INF-5): Admin Activity is always on. Data Access logs are off in dev (log
# ingestion cost, no customer data); the bucket's retention policy stays unlocked (reversible).
audit_data_access_logging = false
audit_lock_retention      = false

# On-call channels (P3-OPS-1): none in dev. pagerduty_service_key / alert_webhook_url are
# secrets and are never set in a tfvars file (TF_VAR_* in the applying shell if ever needed).

# Add a version with `gcloud secrets versions add SIMULATOR_WEBHOOK_SECRET` (openssl rand -hex 32)
# before the first apply: Cloud Run will not start a holder whose secret has no version.
enabled_optional_secrets = ["SIMULATOR_WEBHOOK_SECRET"]
