locals {
  labels = {
    app        = "naaradh"
    env        = var.env
    managed_by = "terraform"
  }

  registry = "${var.region}-docker.pkg.dev/${var.project_id}/${module.artifact_registry.repository_id}"

  # -------------------------------------------------------------------------------------------
  # Service catalog. One Cloud Run service per key. Sizing and `enabled` are overridable per env
  # (var.services); ingress, identity and secrets are not.
  #
  #   public      fronted by the global LB (ingress = internal + cloud load balancing)
  #   armor       Cloud Armor policy key (modules/armor); "" = none (no LB)
  #   cpu_always  CPU allocated outside requests (cpu_idle = false): voice (a cold start mid-call
  #               is dead air, AGENTS.md §2.3) and every worker (poll loops / streaming pull
  #               have no request to wake them)
  # -------------------------------------------------------------------------------------------
  worker_roles = [
    "intents", "dispatcher", "results", "reconcile", "deliveries",
    "actions", "writebacks", "complaints", "retention", "billing", "notifications", "analytics",
  ]
  workers = [for r in local.worker_roles : "workers-${r}"]

  # Pub/Sub-driven roles scale out on backlog; loops that claim rows with SKIP LOCKED may run
  # two instances (dispatcher, ADR-0005); everything else is a single loop.
  worker_max = {
    intents    = 2
    dispatcher = 2
    results    = 2
  }

  service_catalog = merge(
    {
      api = {
        image   = "api", port = 8080, public = true, armor = "api", iap = false, cpu_always = false
        enabled = true, min = 1, max = 10, cpu = "1", memory = "512Mi", timeout = "30s", concurrency = 80
      }
      hooks = {
        # Webhook ack p99 < 800 ms (SPEC §6.8): keep one warm instance.
        image   = "hooks", port = 8080, public = true, armor = "hooks", iap = false, cpu_always = false
        enabled = true, min = 1, max = 10, cpu = "1", memory = "512Mi", timeout = "30s", concurrency = 80
      }
      voice = {
        # min >= 2 and CPU always allocated: a cold start mid-call is dead air (AGENTS.md §2.3).
        image   = "voice", port = 8080, public = true, armor = "voice", iap = false, cpu_always = true
        enabled = true, min = 2, max = 10, cpu = "1", memory = "512Mi", timeout = "60s", concurrency = 40
      }
      web = {
        image   = "web", port = 3000, public = true, armor = "standard", iap = false, cpu_always = false
        enabled = false, min = 0, max = 5, cpu = "1", memory = "1Gi", timeout = "60s", concurrency = 80
      }
      shopify = {
        image   = "shopify", port = 3000, public = true, armor = "standard", iap = false, cpu_always = false
        enabled = false, min = 0, max = 5, cpu = "1", memory = "1Gi", timeout = "60s", concurrency = 80
      }
      console = {
        # Staff only: IAP on the backend service, never reachable without a Google identity.
        image   = "console", port = 3000, public = true, armor = "console", iap = true, cpu_always = false
        enabled = false, min = 0, max = 2, cpu = "1", memory = "1Gi", timeout = "60s", concurrency = 80
      }
    },
    {
      for r in local.worker_roles : "workers-${r}" => {
        image   = "workers", port = 8080, public = false, armor = "", iap = false, cpu_always = true
        enabled = true, min = 1, max = lookup(local.worker_max, r, 1), cpu = "1", memory = "512Mi"
        timeout = "30s", concurrency = 10
      }
    },
  )

  services = {
    for k, v in local.service_catalog : k => merge(v, {
      enabled = coalesce(try(var.services[k].enabled, null), v.enabled)
      min     = coalesce(try(var.services[k].min_instances, null), v.min)
      max     = coalesce(try(var.services[k].max_instances, null), v.max)
      cpu     = coalesce(try(var.services[k].cpu, null), v.cpu)
      memory  = coalesce(try(var.services[k].memory, null), v.memory)
    })
  }
  enabled_services = { for k, v in local.services : k => v if v.enabled }

  # Every principal that runs code: the services plus the migrate job.
  principals = concat(keys(local.service_catalog), ["migrate"])

  # -------------------------------------------------------------------------------------------
  # Secrets. Secret id == env var name. Terraform creates EMPTY containers; humans add versions
  # (docs/runbooks/deploy.md). Optional secrets are mounted only when listed in
  # var.enabled_optional_secrets (Cloud Run will not start a revision on a version-less secret).
  # -------------------------------------------------------------------------------------------
  optional_secrets = [
    "SHOPIFY_WEBHOOK_SECRETS", # per-shop overrides; unset → SHOPIFY_API_SECRET for all shops
    "BOLNA_API_KEY",           # engines: undecided until ADR-0001; simulator needs no key
    "BOLNA_TOOL_TOKEN",        # the bearer Bolna's agent presents on tool calls and caller lookups
    "OMNIDIM_API_KEY",
    "RETELL_API_KEY",
    "RAZORPAY_KEY_ID", # direct INR billing (P2-BILL-3); unset → routes answer 503 / postings wait
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
    "STRIPE_SECRET_KEY", # direct USD billing (P6-BILL-1); unset → routes answer 503 / postings wait
    "STRIPE_WEBHOOK_SECRET",
    "REGION_SYNC_PRIVATE_KEY", # this region's directory signing key (ADR-0012 am. 1); unset → single region
    # Staging only (SIMULATOR_ALLOWED=true there): signs the simulator engine's webhooks and tool
    # calls. Production refuses the simulator, so this secret never exists there.
    "SIMULATOR_WEBHOOK_SECRET",
  ]

  # ===========================================================================================
  # KEY-HOLDER MAP — SECURITY INVARIANT. Who may read which secret.
  #
  # This map drives BOTH the per-secret IAM grant (roles/secretmanager.secretAccessor on the
  # secret, to that service's own service account — never project-wide) AND which secrets are
  # mounted as env vars. A service that is not listed cannot read the secret even by calling the
  # Secret Manager API itself. Rules (AGENTS.md §4, CLAUDE.md invariants 8/15/19, ADR-0004,
  # ADR-0006, ADR-0007), enforced by the preconditions in terraform_data.key_holder_guard below:
  #
  #   PHONE_ENC_PRIVATE_KEY  → ONLY workers dispatcher, results, reconcile (the only code that
  #                            may turn a phone_enc back into a dialable number)
  #   STAFF_ENC_PRIVATE_KEY  → ONLY voice (transfer targets; voice never holds the customer key —
  #                            voice also refuses to boot with it in production)
  #   DATABASE_SERVICE_URL   → ONLY hooks, workers, console (BYPASSRLS). Never api, voice, web,
  #                            shopify: they reach pre-tenant rows via SECURITY DEFINER functions
  #   DATABASE_MIGRATOR_URL  → ONLY the migrate Cloud Run Job (owner role, direct endpoint)
  #
  # Changing a line here is a security review, not a config tweak.
  # ===========================================================================================
  secret_holders = {
    DATABASE_URL          = concat(["api", "voice", "web", "shopify", "console"], local.workers)
    DATABASE_SERVICE_URL  = concat(["hooks", "console"], local.workers)
    DATABASE_MIGRATOR_URL = ["migrate"]
    REDIS_URL             = concat(["api", "voice", "web", "console"], local.workers)

    PHONE_HASH_KEY        = concat(["api", "voice", "web", "shopify", "console"], local.workers)
    PHONE_ENC_PUBLIC_KEY  = concat(["api", "voice"], local.workers)
    PHONE_ENC_PRIVATE_KEY = ["workers-dispatcher", "workers-results", "workers-reconcile"]
    STAFF_ENC_PUBLIC_KEY  = ["api", "web", "shopify"]
    STAFF_ENC_PRIVATE_KEY = ["voice"]

    # Binds engine webhook/tool URLs to a tenant; every worker role's env schema requires it.
    ENGINE_WEBHOOK_KEY       = concat(["hooks", "voice"], local.workers)
    BOLNA_API_KEY            = ["hooks", "voice", "workers-dispatcher", "workers-results", "workers-reconcile"]
    BOLNA_TOOL_TOKEN         = ["hooks", "voice", "workers-dispatcher", "workers-results", "workers-reconcile"]
    SIMULATOR_WEBHOOK_SECRET = ["hooks", "voice", "workers-dispatcher", "workers-results", "workers-reconcile"]
    OMNIDIM_API_KEY          = ["hooks", "voice", "workers-dispatcher", "workers-results", "workers-reconcile"]
    RETELL_API_KEY           = ["hooks", "voice", "workers-dispatcher", "workers-results", "workers-reconcile"]

    # Offline Admin tokens are sealed in Postgres under SHOPIFY_TOKEN_KEY (ADR-0007 §3). Only the
    # app and the workers that call the Admin API hold it; those workers also hold the app's
    # client id/secret to refresh expiring offline tokens.
    SHOPIFY_TOKEN_KEY       = concat(["shopify"], local.shopify_admin_workers)
    SHOPIFY_API_KEY         = concat(["shopify"], local.shopify_admin_workers)
    SHOPIFY_API_SECRET      = concat(["hooks", "shopify"], local.shopify_admin_workers)
    SHOPIFY_WEBHOOK_SECRETS = ["hooks"]

    RAZORPAY_KEY_ID         = ["api", "web", "workers-billing"]
    RAZORPAY_KEY_SECRET     = ["api", "web", "workers-billing"]
    RAZORPAY_WEBHOOK_SECRET = ["hooks"]
    STRIPE_SECRET_KEY       = ["api", "web", "workers-billing"]
    STRIPE_WEBHOOK_SECRET   = ["hooks"]

    # This region's Ed25519 key for directory snapshots. Only the reconcile worker signs; hooks
    # verifies peers with their PUBLIC keys (REGION_PEER_KEYS, plain env — not a secret).
    REGION_SYNC_PRIVATE_KEY = ["workers-reconcile"]

    POSTMARK_TOKEN = ["web", "workers-notifications"]
  }

  # Workers that call the Shopify Admin API (write-backs, cancellations, billing usage records,
  # hourly reconcile).
  shopify_admin_workers = ["workers-writebacks", "workers-actions", "workers-billing", "workers-reconcile"]

  secret_names = sort(keys(local.secret_holders))

  secret_grants = {
    for pair in flatten([
      for secret, holders in local.secret_holders : [
        for h in holders : { secret = secret, holder = h }
      ]
    ]) : "${pair.secret}/${pair.holder}" => pair
  }

  # Secrets actually mounted into a principal's env.
  mounted_secrets = {
    for p in local.principals : p => sort([
      for secret, holders in local.secret_holders : secret
      if contains(holders, p) && (!contains(local.optional_secrets, secret) || contains(var.enabled_optional_secrets, secret))
    ])
  }

  # -------------------------------------------------------------------------------------------
  # Plain env
  # -------------------------------------------------------------------------------------------
  base_env = {
    NODE_ENV            = "production"
    LOG_LEVEL           = "info"
    GCP_PROJECT         = var.project_id
    GCP_REGION          = var.region
    DATA_REGION         = var.data_region
    PUBSUB_TOPIC_PREFIX = "naaradh"
  }

  url_env = merge(
    contains(keys(var.hostnames), "hooks") ? { HOOKS_BASE_URL = "https://${var.hostnames["hooks"]}" } : {},
    contains(keys(var.hostnames), "voice") ? { VOICE_BASE_URL = "https://${var.hostnames["voice"]}" } : {},
  )

  # Who gets RECORDINGS_BUCKET (readers sign URLs; results writes; retention deletes).
  recordings_users = concat(["api", "web", "console"], local.workers)

  service_plain_env = {
    for k, v in local.service_catalog : k => merge(
      local.base_env,
      contains(["voice"], k) || startswith(k, "workers-") ? local.url_env : {},
      contains(local.recordings_users, k) ? { RECORDINGS_BUCKET = module.gcs.recordings_bucket } : {},
      # Behind the external HTTPS LB the client IP is the second-to-last X-Forwarded-For entry
      # (Cloud Run front end + LB = 2 trusted hops). Never `true`: rate limits and API-key IP
      # allow-lists key on this address. [VERIFY on stage: `gcloud logging read` a request's
      # httpRequest.remoteIp against the app's request.ip.]
      v.public ? { TRUST_PROXY_HOPS = "2" } : {},
      var.common_env,
      startswith(k, "workers-") ? { WORKER = trimprefix(k, "workers-") } : {},
      k == "workers-notifications" && contains(keys(var.hostnames), "web") ? { DASHBOARD_URL = "https://${var.hostnames["web"]}" } : {},
      # Nightly facts export (P2-INF-2): dataset + location; the loader runs where the dataset lives.
      k == "workers-analytics" ? { BIGQUERY_DATASET = module.bigquery.dataset_id, BIGQUERY_LOCATION = var.region } : {},
      # Public origins the apps put in links and check Origin against.
      k == "web" && contains(keys(var.hostnames), "web") ? { APP_URL = "https://${var.hostnames["web"]}" } : {},
      k == "shopify" && contains(keys(var.hostnames), "shopify") ? { SHOPIFY_APP_URL = "https://${var.hostnames["shopify"]}" } : {},
      k == "shopify" && contains(keys(var.hostnames), "web") ? { DASHBOARD_URL = "https://${var.hostnames["web"]}" } : {},
      # IAP_AUDIENCE (/projects/<number>/global/backendServices/<id>) exists only after the LB is
      # created; set it through var.service_env.console on the second apply (runbook deploy.md).
      k == "console" && contains(keys(var.hostnames), "console") ? { CONSOLE_ORIGIN = "https://${var.hostnames["console"]}" } : {},
      lookup(var.service_env, k, {}),
    )
  }
}

# ---------------------------------------------------------------------------------------------
# Guard rails: a plan FAILS if someone widens the key-holder map past the invariants above.
# ---------------------------------------------------------------------------------------------
resource "terraform_data" "key_holder_guard" {
  input = local.secret_holders

  lifecycle {
    precondition {
      condition = alltrue([
        for h in local.secret_holders["PHONE_ENC_PRIVATE_KEY"] :
        contains(["workers-dispatcher", "workers-results", "workers-reconcile"], h)
      ])
      error_message = "PHONE_ENC_PRIVATE_KEY may only be held by workers dispatcher, results, reconcile (AGENTS.md §4)."
    }
    precondition {
      condition     = toset(local.secret_holders["STAFF_ENC_PRIVATE_KEY"]) == toset(["voice"])
      error_message = "STAFF_ENC_PRIVATE_KEY is held by voice and nothing else (invariant 19)."
    }
    precondition {
      condition = length(setintersection(
        toset(local.secret_holders["DATABASE_SERVICE_URL"]),
        toset(["api", "voice", "web", "shopify", "migrate"]),
      )) == 0
      error_message = "DATABASE_SERVICE_URL (BYPASSRLS) must never reach api, voice, web or shopify (invariant 15, ADR-0004)."
    }
    precondition {
      condition = alltrue([
        for s in ["SHOPIFY_TOKEN_KEY", "SHOPIFY_API_KEY"] : alltrue([
          for h in local.secret_holders[s] : contains(concat(["shopify"], local.shopify_admin_workers), h)
        ])
      ])
      error_message = "Shopify token key / client id only for the app and the Admin-API workers (ADR-0007)."
    }
    precondition {
      condition     = toset(local.secret_holders["DATABASE_MIGRATOR_URL"]) == toset(["migrate"])
      error_message = "DATABASE_MIGRATOR_URL is mounted into the migrate job only (ADR-0004)."
    }
    precondition {
      condition = alltrue(flatten([
        for secret, holders in local.secret_holders : [for h in holders : contains(local.principals, h)]
      ]))
      error_message = "Every key holder must be a known service key or \"migrate\" (typo guard)."
    }
    precondition {
      condition     = alltrue([for s in local.optional_secrets : contains(local.secret_names, s)])
      error_message = "optional_secrets must be listed in secret_holders."
    }
    precondition {
      condition     = alltrue([for s in var.enabled_optional_secrets : contains(local.optional_secrets, s)])
      error_message = "enabled_optional_secrets may only name secrets from locals.optional_secrets."
    }
    precondition {
      condition = length(setintersection(
        toset(concat(keys(var.common_env), flatten([for m in values(var.service_env) : keys(m)]))),
        toset(local.secret_names),
      )) == 0
      error_message = "A secret name appears in common_env/service_env: secrets come from Secret Manager, never plain env."
    }
    precondition {
      condition     = alltrue([for k in keys(var.services) : contains(keys(local.service_catalog), k)])
      error_message = "var.services has a key that is not in the service catalog."
    }
    precondition {
      condition     = local.services["voice"].min >= 2 && local.services["voice"].cpu_always
      error_message = "voice needs min instances >= 2 with CPU always allocated (AGENTS.md §2.3)."
    }
  }
}
