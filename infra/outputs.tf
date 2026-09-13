output "project_number" {
  value = local.project_number
}

output "nat_egress_ips" {
  description = "Static egress IPs (Cloud NAT). Add every one to Neon's IP allow-list (ADR-0004)."
  value       = module.network.nat_ips
}

output "lb_ip" {
  description = "Global LB address; every public hostname's A record points here."
  value       = try(module.lb[0].ip_address, null)
}

output "dns_records" {
  description = "A records and certificate DNS-authorization CNAMEs to create when DNS is managed elsewhere."
  value       = try(module.lb[0].dns_records, null)
}

output "registry" {
  description = "Image registry prefix: <registry>/<app>:<git-sha>."
  value       = local.registry
}

output "services" {
  description = "Deployed Cloud Run services (name → key-holder view of mounted secrets, names only)."
  value       = { for k, v in module.service : v.name => local.mounted_secrets[k] }
}

output "migrate_job" {
  value = module.migrate.name
}

output "recordings_bucket" {
  value = module.gcs.recordings_bucket
}

output "analytics_dataset" {
  value = module.bigquery.dataset_id
}

output "redis_host" {
  description = "Build the REDIS_URL secret version from this, the port and `terraform output -raw redis_auth_string`."
  value       = module.redis.host
}

output "redis_port" {
  value = module.redis.port
}

output "redis_auth_string" {
  value     = module.redis.auth_string
  sensitive = true
}

output "github_actions" {
  description = "Values for the GitHub environment variables used by .github/workflows (not secrets)."
  value = {
    GCP_PROJECT             = var.project_id
    GCP_REGION              = var.region
    GCP_WIF_PROVIDER        = module.iam.workload_identity_provider
    GCP_DEPLOYER_SA         = module.iam.deployer_email
    GCP_PLANNER_SA          = module.iam.planner_email
    GCP_ARTIFACT_REPOSITORY = local.registry
  }
}

output "runtime_service_accounts" {
  value = module.iam.runtime_emails
}
