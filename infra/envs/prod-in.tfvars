# prod-in — production, India region. NO SECRETS IN THIS FILE (it is committed).
# Deploys are manual (workflow_dispatch → GitHub environment "production" with required
# reviewers). Terraform apply is human-only (docs/runbooks/deploy.md).
project_id = "naaradh-prod-in"
env        = "prod-in"
region     = "asia-south1"

github_repo               = "naaradh/naaradh"
github_deploy_environment = "production"
tf_state_bucket           = "naaradh-tfstate-prod-in"

deletion_protection = true

hostnames = {
  api   = "api.naaradh.com"
  hooks = "hooks.naaradh.com"
  voice = "voice.naaradh.com"
  # Enable together with services.<key>.enabled once the images exist.
  # web     = "app.naaradh.com"
  # shopify = "shopify.naaradh.com"
  # console = "console.naaradh.com"
}

# Apex → web (only routed once web is enabled and has a hostname).
apex_hostnames = ["naaradh.com"]

common_env = {
  LOG_LEVEL         = "info"
  ENGINE_DEFAULT_IN = "simulator" # set to the ADR-0001 winner before launch
  ENGINE_DEFAULT_US = "simulator"
  SHOPIFY_WRITEBACK = "live"
}

services = {
  web     = { enabled = false }
  shopify = { enabled = false }
  console = { enabled = false }
  api     = { min_instances = 2 }
  hooks   = { min_instances = 2 }
  voice   = { min_instances = 3 }
}

service_env = {
  # Until `web` has a hostname here, the notifications worker needs the dashboard URL spelled out.
  "workers-notifications" = { DASHBOARD_URL = "https://app.naaradh.com" }
}

redis = {
  tier           = "STANDARD_HA"
  memory_size_gb = 2
}

nat_ip_count = 2

# hooks and voice stay in preview (vendor payloads trip CRS); flip only after reviewing hits.
waf_preview = {
  api      = false
  hooks    = true
  voice    = true
  standard = false
  console  = false
}

# Voice engines' published egress CIDRs, once the engine is chosen.
engine_ip_allowlist = []

iap_members = [
  # "group:staff@naaradh.com",
]

# Set to the on-call mailbox/group before launch (P0-INF-3 mailboxes).
alert_email = ""
