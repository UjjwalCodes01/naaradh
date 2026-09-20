# Naaradh — one GCP project per environment, built from this root module.
#
#   network ── Cloud NAT static IPs ──► Neon (ADR-0004), vendors
#      │
#      ├── redis (Memorystore, private services access)
#      └── Cloud Run services / migrate job (Direct VPC egress, ALL_TRAFFIC)
#               ▲
#   lb (global HTTPS, Certificate Manager) ── armor ── serverless NEGs
#
#   kms ─► gcs (recordings, CMEK) / bigquery (analytics, CMEK) / audit-logs (locked bucket, CMEK)
#   secrets (empty containers + per-secret IAM from the key-holder map in locals.tf)
#   pubsub (topics, subscriptions, dead letters)   iam (runtime SAs, WIF, deployer, planner)
#   monitoring (uptime, log-match alerts, error rates, Cloud Run SLOs, backlog, DLQ, Redis memory;
#               email + optional PagerDuty / webhook channels)
#
# Apply is human-only (AGENTS.md §1; docs/runbooks/deploy.md). CI runs fmt/validate and a
# read-only plan.

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  project_number = data.google_project.this.number
}

resource "google_project_service" "apis" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "bigquery.googleapis.com",
    "certificatemanager.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "dns.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "iap.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "pubsub.googleapis.com",
    "redis.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
  ])

  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}

# Google-managed service agents that act on our resources.
data "google_storage_project_service_account" "gcs" {
  project    = var.project_id
  depends_on = [google_project_service.apis]
}

data "google_bigquery_default_service_account" "bq" {
  project    = var.project_id
  depends_on = [google_project_service.apis]
}

resource "google_project_service_identity" "pubsub" {
  provider   = google-beta
  project    = var.project_id
  service    = "pubsub.googleapis.com"
  depends_on = [google_project_service.apis]
}

resource "google_project_service_identity" "iap" {
  provider   = google-beta
  project    = var.project_id
  service    = "iap.googleapis.com"
  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------------------------
# Foundation
# ---------------------------------------------------------------------------------------------
module "network" {
  source = "./modules/network"

  project_id        = var.project_id
  region            = var.region
  subnet_cidr       = var.subnet_cidr
  psa_prefix_length = var.psa_cidr_prefix_length
  nat_ip_count      = var.nat_ip_count

  depends_on = [google_project_service.apis]
}

module "kms" {
  source = "./modules/kms"

  project_id    = var.project_id
  region        = var.region
  key_ring_name = "naaradh-${var.env}"
  key_names     = ["recordings", "analytics"]

  encrypter_grants = {
    gcs = {
      key    = "recordings"
      member = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
    }
    bigquery = {
      key    = "analytics"
      member = "serviceAccount:${data.google_bigquery_default_service_account.bq.email}"
    }
  }

  depends_on = [google_project_service.apis]
}

# Audit logs (P3-INF-5): Data Access logs for the data-holding services, every audit log type
# exported to a locked, CMEK bucket with one-year retention (the bucket's `audit` key lives on
# the kms module's ring). Lock is irreversible: var.audit_lock_retention, prod only.
module "audit_logs" {
  source = "./modules/audit-logs"

  project_id          = var.project_id
  region              = var.region
  bucket_name         = "${var.project_id}-audit-logs"
  key_ring_id         = module.kms.key_ring_id
  gcs_service_agent   = data.google_storage_project_service_account.gcs.email_address
  data_access_logging = var.audit_data_access_logging
  lock_retention      = var.audit_lock_retention
  labels              = { service = "audit-logs" }

  depends_on = [module.kms]
}

module "iam" {
  source = "./modules/iam"

  project_id                = var.project_id
  runtime_principals        = local.principals
  github_repo               = var.github_repo
  github_deploy_environment = var.github_deploy_environment
  tf_state_bucket           = var.tf_state_bucket

  depends_on = [google_project_service.apis]
}

module "artifact_registry" {
  source = "./modules/artifact-registry"

  project_id = var.project_id
  region     = var.region
  writers    = { deployer = "serviceAccount:${module.iam.deployer_email}" }

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------------------------
# Data plane
# ---------------------------------------------------------------------------------------------
module "secrets" {
  source = "./modules/secrets"

  project_id     = var.project_id
  project_number = local.project_number
  region         = var.region
  secret_names   = local.secret_names
  holder_counts  = local.secret_holders

  grants = {
    for k, g in local.secret_grants : k => {
      secret = g.secret
      member = "serviceAccount:${module.iam.runtime_emails[g.holder]}"
    }
  }

  # merchant-webhook-* secrets: api creates them, the deliveries worker reads them.
  runtime_secret_writers = { api = "serviceAccount:${module.iam.runtime_emails["api"]}" }
  runtime_secret_readers = { deliveries = "serviceAccount:${module.iam.runtime_emails["workers-deliveries"]}" }

  depends_on = [google_project_service.apis, terraform_data.key_holder_guard]
}

module "redis" {
  source = "./modules/redis"

  project_id     = var.project_id
  region         = var.region
  network_id     = module.network.network_id
  tier           = var.redis.tier
  memory_size_gb = var.redis.memory_size_gb
  redis_version  = var.redis.version

  depends_on = [module.network]
}

module "pubsub" {
  source = "./modules/pubsub"

  project_id     = var.project_id
  project_number = local.project_number
  region         = var.region
  prefix         = "naaradh"

  # apps/hooks/src/pubsub.ts TopicName. provider.events has no consumer yet: Pub/Sub drops
  # messages published to a topic without subscriptions — add one with its consumer.
  topics = ["shopify.events", "engine.events", "provider.events", "billing.events"]

  subscriptions = [
    { topic = "shopify.events", worker = "intents", member = "serviceAccount:${module.iam.runtime_emails["workers-intents"]}" },
    { topic = "engine.events", worker = "results", member = "serviceAccount:${module.iam.runtime_emails["workers-results"]}" },
    { topic = "billing.events", worker = "billing", member = "serviceAccount:${module.iam.runtime_emails["workers-billing"]}" },
  ]

  publishers = { hooks = "serviceAccount:${module.iam.runtime_emails["hooks"]}" }

  depends_on = [google_project_service_identity.pubsub]
}

module "gcs" {
  source = "./modules/gcs"

  project_id          = var.project_id
  region              = var.region
  bucket_name         = "${var.project_id}-recordings"
  kms_key_id          = module.kms.key_ids["recordings"]
  soft_delete_seconds = var.recordings_soft_delete_seconds

  iam = merge(
    # Readers mint V4 signed URLs for playback (never public objects).
    { for p in ["api", "web", "console"] : "${p}-read" => {
      role   = "roles/storage.objectViewer"
      member = "serviceAccount:${module.iam.runtime_emails[p]}"
    } },
    {
      # results copies vendor recordings in (E-34) and may overwrite on redelivery, which needs
      # delete; retention deletes on schedule and on erasure requests.
      "results-write" = {
        role   = "roles/storage.objectUser"
        member = "serviceAccount:${module.iam.runtime_emails["workers-results"]}"
      }
      "retention-delete" = {
        role   = "roles/storage.objectUser"
        member = "serviceAccount:${module.iam.runtime_emails["workers-retention"]}"
      }
    },
  )

  depends_on = [module.kms]
}

# V4 signed URLs on Cloud Run are signed through the IAM signBlob API with the service's own
# identity: each signer may sign as ITSELF only.
resource "google_service_account_iam_member" "self_sign" {
  for_each = toset(["api", "web", "console"])

  service_account_id = module.iam.runtime_ids[each.key]
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${module.iam.runtime_emails[each.key]}"
}

module "bigquery" {
  source = "./modules/bigquery"

  project_id          = var.project_id
  region              = var.region
  kms_key_id          = module.kms.key_ids["analytics"]
  exporter_email      = module.iam.runtime_emails["workers-analytics"]
  deletion_protection = var.deletion_protection

  depends_on = [module.kms]
}

# ---------------------------------------------------------------------------------------------
# Cloud Run
# ---------------------------------------------------------------------------------------------
module "service" {
  source   = "./modules/cloudrun-service"
  for_each = local.enabled_services

  project_id            = var.project_id
  region                = var.region
  name                  = each.key
  image                 = var.image_tag == "bootstrap" ? var.bootstrap_image : "${local.registry}/${each.value.image}:${var.image_tag}"
  service_account_email = module.iam.runtime_emails[each.key]
  ingress               = each.value.public ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_INTERNAL_ONLY"
  port                  = each.value.port
  cpu                   = each.value.cpu
  memory                = each.value.memory
  cpu_always            = each.value.cpu_always
  min_instances         = each.value.min
  max_instances         = each.value.max
  timeout               = each.value.timeout
  concurrency           = each.value.concurrency
  env                   = local.service_plain_env[each.key]
  secret_env            = local.mounted_secrets[each.key]
  # Next.js apps (web/shopify/console) are not required to expose /readyz.
  startup_path = contains(["web", "shopify", "console"], each.key) ? "/healthz" : "/readyz"
  network      = module.network.network_id
  subnetwork   = module.network.subnet_id

  # Public services: ingress already limits callers to the LB, so the IAM invoker check is off
  # (works under the domain-restricted-sharing org policy, unlike allUsers). The console keeps
  # the check and admits only the IAP service agent.
  public_invoker = each.value.public && !each.value.iap
  invokers       = each.value.iap ? { iap = "serviceAccount:${google_project_service_identity.iap.email}" } : {}

  deletion_protection = var.deletion_protection
  labels              = { service = each.key }

  depends_on = [module.secrets, module.redis]
}

module "migrate" {
  source = "./modules/cloudrun-job"

  project_id = var.project_id
  region     = var.region
  name       = "migrate"
  image      = var.image_tag == "bootstrap" ? var.bootstrap_image : "${local.registry}/workers:${var.image_tag}"
  # Always the migrate entrypoint of the workers image (apps/workers/Dockerfile). With the
  # bootstrap placeholder image the job exists but must not be executed until CI sets a real one.
  command               = ["node"]
  args                  = ["dist/migrate.js"]
  service_account_email = module.iam.runtime_emails["migrate"]
  env                   = { NODE_ENV = "production" }
  secret_env            = local.mounted_secrets["migrate"]
  network               = module.network.network_id
  subnetwork            = module.network.subnet_id
  deletion_protection   = var.deletion_protection
  labels                = { service = "migrate" }

  depends_on = [module.secrets]
}

# ---------------------------------------------------------------------------------------------
# Edge
# ---------------------------------------------------------------------------------------------
locals {
  lb_services = {
    for k, v in local.enabled_services : k => v
    if v.public && contains(keys(var.hostnames), k)
  }

  armor_policies = {
    api = {
      description = "api.<domain>: merchant REST API"
      rate_limit  = { action = "throttle", count = 120, interval_sec = 60 }
      waf_preview = lookup(var.waf_preview, "api", true)
      # >= 1,000,000 bytes (the app's bodyLimit is 256 KiB).
      body_cap_regex = "^[0-9]{7,}$"
    }
    hooks = {
      description = "hooks.<domain>: Shopify, engine, Razorpay webhooks"
      # Ban on exceed. Shopify/engines retry failed deliveries, so a false ban delays events
      # rather than losing them; tune once real traffic is known.
      rate_limit = { action = "ban", count = 600, interval_sec = 60, ban_sec = 600 }
      # WAF in PREVIEW (log only): Shopify order payloads and engine transcripts routinely trip
      # CRS SQLi/XSS signatures. Enforce only after reviewing preview hits.
      waf_preview = lookup(var.waf_preview, "hooks", true)
      # >= 2,000,000 bytes (the app's bodyLimit is 1 MiB).
      body_cap_regex = "^([2-9][0-9]{6}|[0-9]{8,})$"
    }
    voice = {
      description = "voice.<domain>: engine inbound-context and mid-call tool calls"
      # THROTTLE, never ban: engines call from a handful of IPs, and a ban mid-call is dead air.
      rate_limit     = { action = "throttle", count = 2400, interval_sec = 60 }
      waf_preview    = lookup(var.waf_preview, "voice", true)
      body_cap_regex = "^[0-9]{7,}$"
      # Engines' published egress ranges bypass the limit once known (ADR-0001).
      allow_ranges = var.engine_ip_allowlist
    }
    standard = {
      description    = "web / shopify: browser traffic"
      rate_limit     = { action = "throttle", count = 600, interval_sec = 60 }
      waf_preview    = lookup(var.waf_preview, "standard", true)
      body_cap_regex = "^[0-9]{8,}$"
    }
    console = {
      description    = "console.<domain>: staff console behind IAP"
      rate_limit     = { action = "throttle", count = 300, interval_sec = 60 }
      waf_preview    = lookup(var.waf_preview, "console", true)
      body_cap_regex = "^[0-9]{8,}$"
    }
  }

  used_armor_policies = { for k, v in local.armor_policies : k => v if contains([for s in values(local.lb_services) : s.armor], k) }
}

module "armor" {
  source = "./modules/armor"
  count  = length(local.lb_services) > 0 ? 1 : 0

  project_id = var.project_id
  policies   = local.used_armor_policies

  depends_on = [google_project_service.apis]
}

module "lb" {
  source = "./modules/lb"
  count  = length(local.lb_services) > 0 ? 1 : 0

  project_id = var.project_id
  region     = var.region

  backends = {
    for k, v in local.lb_services : k => {
      service_name    = module.service[k].name
      hostnames       = k == "web" ? concat([var.hostnames[k]], var.apex_hostnames) : [var.hostnames[k]]
      security_policy = module.armor[0].policy_ids[v.armor]
      iap             = v.iap
    }
  }

  iap_members      = var.iap_members
  dns_managed_zone = var.dns.managed_zone
  dns_project      = var.dns.project
}

# ---------------------------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------------------------
module "monitoring" {
  source = "./modules/monitoring"

  project_id = var.project_id
  env        = var.env

  # Channels (P3-OPS-1): email gets everything; PagerDuty / webhook get CRITICAL only. The two
  # keys are secrets: TF_VAR_pagerduty_service_key / TF_VAR_alert_webhook_url in the applying
  # shell, never in envs/*.tfvars.
  alert_email           = var.alert_email
  pagerduty_service_key = var.pagerduty_service_key
  alert_webhook_url     = var.alert_webhook_url

  # Cloud Run SLO policies are created only for services enabled in this environment; Pub/Sub
  # backlog is watched on every worker subscription.
  run_services  = keys(local.enabled_services)
  subscriptions = values(module.pubsub.subscriptions)

  uptime_hosts = {
    for k in ["api", "hooks", "voice", "web"] : k => var.hostnames[k]
    if contains(keys(local.lb_services), k)
  }

  dead_letter_subscriptions = values(module.pubsub.dead_letter_hold_subscriptions)

  # Messages the code logs when a human must act. Substring match on jsonPayload.message/.msg.
  log_alerts = {
    global_kill = {
      match    = "GLOBAL KILL SWITCH tripped"
      summary  = "Global kill switch tripped on complaints (E-05)"
      severity = "CRITICAL"
      runbook  = "complaint-received.md"
    }
    tenant_auto_paused = {
      match    = "tenant auto-paused on complaints"
      summary  = "Tenant auto-paused on complaints (E-05)"
      severity = "ERROR"
      runbook  = "complaint-received.md"
    }
    outbound_disclosure_missing = {
      match    = "human answered but no disclosure logged"
      summary  = "Outbound call answered without logged AI/recording disclosure (invariant 7)"
      severity = "CRITICAL"
      runbook  = "kill-switch.md"
    }
    inbound_disclosure_missing = {
      match    = "inbound greeting lacks disclosure"
      summary  = "Inbound profile greeting lacks disclosure; calls fall back (invariant 7)"
      severity = "CRITICAL"
      runbook  = "inbound-fallback.md"
    }
    script_invalid = {
      match    = "approved script fails validation"
      summary  = "Approved script fails validation; dispatcher refusing to dial"
      severity = "ERROR"
      runbook  = "kill-switch.md"
    }
    engine_circuit_open = {
      match    = "engine circuit OPEN"
      summary  = "Voice engine circuit breaker open (E-20)"
      severity = "ERROR"
      runbook  = "engine-outage.md"
    }
    erasure_overdue = {
      match    = "erasure requests past due"
      summary  = "Erasure requests past their due date (DPDP)"
      severity = "ERROR"
      runbook  = "erasure-request.md"
    }
    erasure_failed = {
      match    = "erasure failed"
      summary  = "An erasure request failed"
      severity = "ERROR"
      runbook  = "erasure-request.md"
    }
    writeback_gave_up = {
      match    = "shopify writeback gave up"
      summary  = "Shopify write-back gave up after retries"
      severity = "WARNING"
      runbook  = "shopify-writeback.md"
    }
    billing_posting_failed = {
      match    = "billing posting failed"
      summary  = "Billing posting failed (non-retryable)"
      severity = "ERROR"
      runbook  = "billing-postings.md"
    }
    billing_reconciliation_delta = {
      match    = "billing reconciliation delta"
      summary  = "Billing reconciliation delta is not 0"
      severity = "ERROR"
      runbook  = "billing-postings.md"
    }
    tenant_capped = {
      match    = "tenant capped (E-61)"
      summary  = "Tenant hit its Shopify capped amount (E-61)"
      severity = "WARNING"
      runbook  = "billing-postings.md"
    }
    dnc_registry_stale = {
      match    = "dnc registry missing or stale"
      summary  = "A national do-not-call list is missing, stale or about to expire: marketing calls there are refused"
      severity = "WARNING"
      runbook  = "dnc-registry.md"
    }
    unsigned_mismatch = {
      match    = "unsigned engine event contradicted by the fetched record"
      summary  = "An unsigned engine webhook did not match the vendor's own record (forged or mis-mapped)"
      severity = "WARNING"
      runbook  = "stuck-attempts.md"
    }
    region_directory_push_failed = {
      match    = "directory push"
      summary  = "Region directory could not be pushed to a peer (stale routing of Shopify webhooks)"
      severity = "WARNING"
      runbook  = "region-directory.md"
    }
    gross_margin_low = {
      match    = "gross margin below 40%"
      summary  = "Tenant gross margin below 40% (E-33)"
      severity = "WARNING"
      runbook  = "billing-postings.md"
    }
    recording_persist_failed = {
      match    = "recording persist failed"
      summary  = "Vendor recording not copied to our bucket (E-34)"
      severity = "WARNING"
      runbook  = "stuck-attempts.md"
    }
    loop_unhealthy = {
      match    = "worker loop unhealthy"
      summary  = "A worker loop has failed 5 times in a row (database or Redis unreachable?)"
      severity = "ERROR"
      runbook  = "deploy.md"
      section  = "After every deploy — check"
    }
  }

  depends_on = [google_project_service.apis]
}
