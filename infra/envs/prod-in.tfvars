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
  LOG_LEVEL = "info"
  # Production refuses the simulator: set the ADR-0001 winner (bolna | omnidim) and enable its
  # key below (enabled_optional_secrets) before the first prod-in deploy.
  ENGINE_DEFAULT_IN = "simulator"
  ENGINE_DEFAULT_US = "simulator"
  SHOPIFY_WRITEBACK = "live"
  # BOLNA_TELEPHONY_PROVIDER = "plivo"   # the telephony account connected to Bolna
  # BOLNA_INBOUND            = "true"    # only after go-live 03 §inbound has been verified
  # Once prod-us / prod-eu exist (go-live 10 §7): this deployment receives every store's Shopify
  # webhooks, so it must know its peers to pass the foreign ones on.
  # REGION_PEERS     = "{\"us\":\"https://hooks.us.naaradh.com\",\"eu\":\"https://hooks.eu.naaradh.com\"}"
  # REGION_PEER_KEYS = "{\"us\":\"<public key>\",\"eu\":\"<public key>\"}"
}

# Optional secrets are mounted only when named here, and only once a version exists in Secret
# Manager (Cloud Run refuses to start on a version-less secret). Uncomment each as its account
# is linked:
enabled_optional_secrets = [
  # "BOLNA_API_KEY", "BOLNA_TOOL_TOKEN",                                   # go-live 03
  # "OMNIDIM_API_KEY",                                                     # go-live 03
  # "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET",   # go-live 06
  # "REGION_SYNC_PRIVATE_KEY",                                             # go-live 10 §7
]

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

# Voice engines' published egress CIDRs. Bolna signs nothing and publishes these three webhook
# source IPs instead (docs.bolna.ai, Sep 2026) — set them when Bolna is the engine: [VERIFY]
#   engine_ip_allowlist = ["13.203.39.153/32", "13.126.9.249/32", "13.202.133.53/32"]
engine_ip_allowlist = []

iap_members = [
  # "group:staff@naaradh.com",
]

# Set to the on-call mailbox/group before launch (P0-INF-3 mailboxes).
alert_email = ""

# Audit logs (P3-INF-5): Data Access logs on for Secret Manager, GCS, KMS, BigQuery, IAP.
# audit_lock_retention = true LOCKS the audit bucket's 365-day retention policy on the next apply.
# This is IRREVERSIBLE (GCS Bucket Lock): the policy can never be shortened or removed and the
# bucket cannot be deleted for a year after its last write. Review the plan line for
# module.audit_logs.google_storage_bucket.audit before applying it the first time.
audit_data_access_logging = true
audit_lock_retention      = true

# On-call channels (P3-OPS-1): set alert_email above, then pass the paging channel(s) as
# TF_VAR_pagerduty_service_key and/or TF_VAR_alert_webhook_url in the applying shell — they are
# secrets and must never be written into this file.
