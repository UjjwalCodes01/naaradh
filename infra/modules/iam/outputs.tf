output "runtime_emails" {
  description = "Runtime service account email by principal key."
  value       = { for k, v in google_service_account.runtime : k => v.email }
}

output "runtime_ids" {
  description = "Runtime service account resource name by principal key."
  value       = { for k, v in google_service_account.runtime : k => v.name }
}

output "deployer_email" {
  value = google_service_account.deployer.email
}

output "planner_email" {
  value = google_service_account.planner.email
}

output "workload_identity_provider" {
  description = "Value for the GitHub variable GCP_WIF_PROVIDER."
  value       = google_iam_workload_identity_pool_provider.github.name
}
