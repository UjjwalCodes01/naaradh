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
