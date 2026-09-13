# Memorystore for Redis 7: kill-switch cache (5 s TTL, invariant 12), concurrency counters,
# complaint windows, rate limits. Everything in it is reconstructable (the reconcile worker repairs
# counters), so no persistence; STANDARD_HA in production for availability, not durability.
#
# Reached from Cloud Run over Direct VPC egress through private services access. AUTH is on;
# REDIS_URL (a Secret Manager secret, built by a human from the outputs — docs/runbooks/deploy.md)
# carries the AUTH string. In-transit TLS is off: with SERVER_AUTHENTICATION the clients must trust
# the instance CA, which ioredis in the apps is not configured for yet. Traffic never leaves the
# VPC peering. Turning TLS on is an app change (rediss:// + CA) plus `transit_encryption_mode`.

resource "google_redis_instance" "cache" {
  project        = var.project_id
  name           = var.name
  region         = var.region
  tier           = var.tier
  memory_size_gb = var.memory_size_gb
  redis_version  = var.redis_version

  authorized_network      = var.network_id
  connect_mode            = "PRIVATE_SERVICE_ACCESS"
  auth_enabled            = true
  transit_encryption_mode = "DISABLED"

  redis_configs = {
    # Never evict silently: an evicted kill-switch or suppression-cache key would quietly re-open
    # dispatch (invariants 6, 12). A full instance must fail loudly instead (alert on memory).
    "maxmemory-policy" = "noeviction"
  }

  maintenance_policy {
    weekly_maintenance_window {
      day = "TUESDAY"
      start_time {
        # 21:30 UTC = 03:00 IST, outside the 09:00–21:00 IST calling window (invariant 3).
        hours   = 21
        minutes = 30
      }
    }
  }
}
