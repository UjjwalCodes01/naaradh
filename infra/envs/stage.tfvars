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
