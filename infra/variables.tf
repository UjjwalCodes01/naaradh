# Root inputs. Environment values live in envs/<env>.tfvars (no secrets there, ever — secret
# VALUES are added to Secret Manager by a human, docs/runbooks/deploy.md "Secrets").

variable "project_id" {
  description = "GCP project for this environment (naaradh-dev | naaradh-stage-in | naaradh-prod-in)."
  type        = string
}

variable "env" {
  description = "Environment name; also the tfvars file name."
  type        = string
  validation {
    condition     = contains(["dev", "stage", "prod-in"], var.env)
    error_message = "env must be one of dev, stage, prod-in."
  }
}

variable "region" {
  description = "Primary region. Org policy restricts resource locations to asia-south1/asia-south2 (AGENTS.md §2.3)."
  type        = string
  default     = "asia-south1"
  validation {
    condition     = contains(["asia-south1", "asia-south2"], var.region)
    error_message = "India projects run in asia-south1 (primary) or asia-south2."
  }
}

# ---------------------------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------------------------

variable "image_tag" {
  description = <<-EOT
    Image tag (git SHA) used when Terraform CREATES a Cloud Run service or job. After creation CI
    owns the image (`gcloud run services update --image`, .github/workflows/deploy.yml) and
    Terraform ignores image drift, so a plan never rolls a deploy back. "bootstrap" means: use
    var.bootstrap_image, for the very first apply before any image has been pushed.
  EOT
  type        = string
  default     = "bootstrap"
}

variable "bootstrap_image" {
  description = "Placeholder image for the first apply only (answers 200 on every path, listens on $PORT)."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

# ---------------------------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------------------------

variable "services" {
  description = <<-EOT
    Per-environment overrides of the service catalog in locals.tf (keys: api, hooks, voice, web,
    shopify, console, workers-<role>). Only sizing and on/off are overridable here — ingress,
    secrets and identity are fixed in code on purpose.
  EOT
  type = map(object({
    enabled       = optional(bool)
    min_instances = optional(number)
    max_instances = optional(number)
    cpu           = optional(string)
    memory        = optional(string)
  }))
  default = {}
  validation {
    condition = alltrue([
      for k, v in var.services : v.min_instances == null || v.max_instances == null || v.min_instances <= v.max_instances
    ])
    error_message = "min_instances must be <= max_instances."
  }
}

variable "common_env" {
  description = <<-EOT
    Plain (non-secret) environment variables for every service and the migrate job, e.g.
    ENGINE_DEFAULT_IN, LOG_LEVEL, SHOPIFY_WRITEBACK. Anything secret goes to Secret Manager and the
    key-holder map instead; a key that is also a secret name is rejected.
  EOT
  type        = map(string)
  default     = {}
}

variable "service_env" {
  description = "Plain env per service key, merged over common_env (e.g. { \"workers-dispatcher\" = { DISPATCH_BATCH = \"20\" } })."
  type        = map(map(string))
  default     = {}
}

variable "enabled_optional_secrets" {
  description = <<-EOT
    Optional secrets (locals.tf optional_secrets) that have a version in this environment and should
    be mounted into their holders. Cloud Run refuses to start a revision whose secret has no
    version, so an optional secret is mounted only once a human has added one and listed it here.
  EOT
  type        = list(string)
  default     = []
}

variable "deletion_protection" {
  description = "Protect Cloud Run services/jobs, buckets, datasets and Redis from `terraform destroy`."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------------------------

variable "subnet_cidr" {
  description = "Subnet used by Cloud Run Direct VPC egress (each instance takes an IP; /22 leaves headroom)."
  type        = string
  default     = "10.10.0.0/22"
}

variable "psa_cidr_prefix_length" {
  description = "Prefix length of the private services access range (Memorystore; Cloud SQL if Q-16 forces a move)."
  type        = number
  default     = 20
}

variable "nat_ip_count" {
  description = "Static egress IPs for Cloud NAT. These are what Neon's IP allow-list and vendors see (ADR-0004, AGENTS.md §11)."
  type        = number
  default     = 1
}

# ---------------------------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------------------------

variable "redis" {
  description = "Memorystore sizing. STANDARD_HA in production (kill-switch cache, counters)."
  type = object({
    tier           = string
    memory_size_gb = number
    version        = optional(string, "REDIS_7_2")
  })
  default = {
    tier           = "BASIC"
    memory_size_gb = 1
  }
}

# ---------------------------------------------------------------------------------------------
# Edge: hostnames, LB, Armor, IAP
# ---------------------------------------------------------------------------------------------

variable "hostnames" {
  description = "Public hostname per LB-fronted service key (api, hooks, voice, web, shopify, console). Services without an entry get no LB route."
  type        = map(string)
  default     = {}
}

variable "apex_hostnames" {
  description = "Extra hostnames routed to the web service (prod: [\"naaradh.com\"])."
  type        = list(string)
  default     = []
}

variable "dns" {
  description = "Cloud DNS zone to write A records and certificate DNS-authorization CNAMEs into. Empty managed_zone → records are output for a human to create."
  type = object({
    managed_zone = string
    project      = optional(string)
  })
  default = { managed_zone = "" }
}

variable "waf_preview" {
  description = <<-EOT
    Per Armor policy: true = preconfigured WAF rules only LOG (preview), false = enforce. hooks and
    voice default to preview because vendor payloads (Shopify orders, transcripts) trip SQLi/XSS
    signatures; flip only after reviewing the preview hits in Cloud Logging.
  EOT
  type        = map(bool)
  default = {
    api      = false
    hooks    = true
    voice    = true
    standard = false
    console  = false
  }
}

variable "engine_ip_allowlist" {
  description = "Voice engines' published egress ranges (CIDRs). When set, they bypass the voice rate limit. Empty until the engine is chosen (ADR-0001)."
  type        = list(string)
  default     = []
}

variable "iap_members" {
  description = "Who may reach console.<domain> through IAP (e.g. group:staff@naaradh.com). Empty → nobody."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------------------------
# CI identities
# ---------------------------------------------------------------------------------------------

variable "github_repo" {
  description = "owner/name of the GitHub repository allowed to use Workload Identity Federation."
  type        = string
}

variable "github_deploy_environment" {
  description = "GitHub Actions environment whose jobs may impersonate the deployer SA (the OIDC sub is repo:<repo>:environment:<name>)."
  type        = string
}

variable "tf_state_bucket" {
  description = "Name of the (hand-made) Terraform state bucket; the read-only planner gets object read on it. Empty → no grant."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------------------------

variable "alert_email" {
  description = "Email notification channel for alert policies. Empty → policies exist without a channel (visible in the console only)."
  type        = string
  default     = ""
}

variable "recordings_soft_delete_seconds" {
  description = <<-EOT
    GCS soft-delete window on the recordings bucket. 0 (default) = a deleted object is gone: an
    erasure or retention delete really erases (DPDP; erasure-request.md). >0 keeps deleted media
    recoverable for that long, which protects against a buggy bulk delete but means "erased" media
    still exists for the window. Product/legal decision — see docs/runbooks/deploy.md.
  EOT
  type        = number
  default     = 0
}

variable "pagerduty_service_key" {
  description = <<-EOT
    PagerDuty Events API v2 integration key for the on-call service; creates a channel that
    CRITICAL alert policies page (P3-OPS-1). It is a secret: pass it as
    TF_VAR_pagerduty_service_key in the applying shell, never in envs/*.tfvars. Empty → no
    PagerDuty channel. Terraform keeps it in state (as it does the Redis AUTH string).
  EOT
  type        = string
  default     = ""
  sensitive   = true
}

variable "alert_webhook_url" {
  description = <<-EOT
    Token-in-URL incoming-webhook of an on-call service (Better Stack, Opsgenie, Zenduty, …);
    CRITICAL alert policies POST to it. Secret (the token is in the URL): TF_VAR_alert_webhook_url,
    never in tfvars. Empty → no webhook channel.
  EOT
  type        = string
  default     = ""
  sensitive   = true
}

# ---------------------------------------------------------------------------------------------
# Audit logs (P3-INF-5)
# ---------------------------------------------------------------------------------------------

variable "audit_data_access_logging" {
  description = <<-EOT
    Enable Data Access audit logs (DATA_READ + DATA_WRITE) for Secret Manager, Cloud Storage,
    Cloud KMS, BigQuery and IAP. Admin Activity logs are always on regardless. The entries are
    billed as log ingestion (modules/audit-logs has the cost notes): off in dev, on in stage and
    prod so the evidence trail after an incident is complete.
  EOT
  type        = bool
  default     = true
}

variable "audit_lock_retention" {
  description = <<-EOT
    Lock the audit bucket's 365-day retention policy (GCS Bucket Lock). IRREVERSIBLE: a locked
    policy can never be removed or shortened and the bucket cannot be deleted until every object
    has aged out. false everywhere except prod-in.tfvars.
  EOT
  type        = bool
  default     = false
  validation {
    condition     = !var.audit_lock_retention || startswith(var.env, "prod")
    error_message = "audit_lock_retention is irreversible; it may only be true in a prod environment."
  }
}
