# prod-eu — production, European Union (and UK) region (ADR-0012, PLAN Phase 6 P6-INF-1). NO SECRETS IN THIS FILE.
# A separate Google Cloud project from prod-in: its own database, Redis, Pub/Sub, recordings
# bucket and BigQuery dataset. Nothing here ever connects to another region's stores.
# Terraform apply is human-only (docs/runbooks/deploy.md, docs/go-live/10-us-eu.md).
project_id  = "naaradh-prod-eu"
env         = "prod-eu"
data_region = "eu"
region      = "europe-west1"

github_repo               = "naaradh/naaradh"
github_deploy_environment = "production-eu"
tf_state_bucket           = "naaradh-tfstate-prod-eu"

deletion_protection = true

# Engine webhooks, the API and the support line for European Union (and UK) merchants. Shopify webhooks still arrive
# at hooks.naaradh.com (one URL per app) and are forwarded here by the region directory.
hostnames = {
  api   = "api.eu.naaradh.com"
  hooks = "hooks.eu.naaradh.com"
  voice = "voice.eu.naaradh.com"
  # Enable together with services.<key>.enabled once the images exist.
  # web     = "app.eu.naaradh.com"
  # console = "console.eu.naaradh.com"
}

common_env = {
  LOG_LEVEL = "info"
  # No +91 CLI exists in this project, so the gate refuses any Indian recipient before an engine
  # is chosen (invariant 2: never a foreign CLI into India); production refuses the simulator.
  ENGINE_DEFAULT_IN = "retell"
  ENGINE_DEFAULT_US = "retell" # [VERIFY] after the recorded-payload pass (docs/go-live/10-us-eu.md)
  SHOPIFY_WRITEBACK = "live"
  # National do-not-call lists that must be loaded and fresh before any dial (runbook dnc-registry.md).
  DND_REGISTRY_REGIONS = "GB"
  # The other deployments' hooks, for the region directory (ADR-0012 §4).
  REGION_PEERS = "{\"in\":\"https://hooks.naaradh.com\",\"us\":\"https://hooks.us.naaradh.com\"}"
  # Each peer\'s Ed25519 PUBLIC key (docs/runbooks/region-directory.md#keys) — not a secret.
  REGION_PEER_KEYS = "{}"
}

# Mounted once a version exists in Secret Manager (a human adds it — never in this file).
enabled_optional_secrets = [
  "RETELL_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "REGION_SYNC_PRIVATE_KEY",
]

services = {
  web     = { enabled = false }
  shopify = { enabled = false } # one embedded app, served from prod-in
  console = { enabled = false }
  api     = { min_instances = 1 }
  hooks   = { min_instances = 1 }
  voice   = { min_instances = 2 } # AGENTS §2.3: a live call never waits for a cold start
}

service_env = {
  # Plan code → Stripe USD price id (not secret). Filled from the Stripe dashboard before launch.
  api = { STRIPE_PRICE_IDS = "{}" }
}

redis = {
  tier           = "STANDARD_HA"
  memory_size_gb = 1
}

nat_ip_count = 1

waf_preview = {
  api      = false
  hooks    = true
  voice    = true
  standard = false
  console  = false
}

# Retell's published egress CIDRs, once confirmed from its documentation. [VERIFY]
engine_ip_allowlist = []

iap_members = []

alert_email = ""

audit_data_access_logging = true
# Leave false until the first apply of this project has been reviewed (IRREVERSIBLE — see prod-in).
audit_lock_retention = false
