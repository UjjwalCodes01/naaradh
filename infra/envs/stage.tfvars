# stage-in — pre-production, India region. NO SECRETS IN THIS FILE (it is committed).
# main → stage deploys automatically (.github/workflows/deploy.yml, GitHub environment "stage").
project_id = "naaradh-stage-in"
env        = "stage"
region     = "asia-south1"

github_repo               = "naaradh/naaradh"
github_deploy_environment = "stage"
tf_state_bucket           = "naaradh-tfstate-stage-in"

deletion_protection = false

hostnames = {
  api   = "api.stage.naaradh.com"
  hooks = "hooks.stage.naaradh.com"
  voice = "voice.stage.naaradh.com"
  # Enable together with services.<key>.enabled once the images exist (P2-WEB-1, P2-SHOP-1).
  # web     = "app.stage.naaradh.com"
  # shopify = "shopify.stage.naaradh.com"
  # console = "console.stage.naaradh.com"
}

common_env = {
  LOG_LEVEL         = "info"
  ENGINE_DEFAULT_IN = "simulator" # until the bake-off picks an engine (ADR-0001)
  ENGINE_DEFAULT_US = "simulator"
  # The simulator is refused in production unless said so explicitly (refineEngineEnv); its
  # webhook secret is a real secret here (SIMULATOR_WEBHOOK_SECRET below), never the dev default.
  SIMULATOR_ALLOWED = "true"
  SHOPIFY_WRITEBACK = "recording"
}

services = {
  web     = { enabled = false }
  shopify = { enabled = false }
  console = { enabled = false }
}

service_env = {
  # Until `web` has a hostname here, the notifications worker needs the dashboard URL spelled out.
  "workers-notifications" = { DASHBOARD_URL = "https://app.stage.naaradh.com" }
}

redis = {
  tier           = "BASIC"
  memory_size_gb = 1
}

# Stage runs everything in preview first; prod enforces api/standard/console.
waf_preview = {
  api      = true
  hooks    = true
  voice    = true
  standard = true
  console  = true
}

iap_members = [
  # "group:staff@naaradh.com",
]

alert_email = ""

# Audit logs (P3-INF-5): Data Access logs on (same evidence trail as prod, exercised here first);
# retention policy NOT locked — stage buckets must stay deletable.
audit_data_access_logging = true
audit_lock_retention      = false

# On-call channels (P3-OPS-1): email only in stage. pagerduty_service_key / alert_webhook_url are
# secrets and are never set in a tfvars file (TF_VAR_* in the applying shell).

# Add a version with `gcloud secrets versions add SIMULATOR_WEBHOOK_SECRET` (openssl rand -hex 32)
# before the first apply: Cloud Run will not start a holder whose secret has no version.
enabled_optional_secrets = ["SIMULATOR_WEBHOOK_SECRET"]
