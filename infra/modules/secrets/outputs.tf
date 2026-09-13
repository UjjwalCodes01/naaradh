output "secret_ids" {
  description = "Secret resource ids by name."
  value       = { for k, v in google_secret_manager_secret.secret : k => v.id }
}

output "secret_names" {
  value = keys(google_secret_manager_secret.secret)
}

output "accessor_grants" {
  description = "Grant keys (\"<SECRET>/<holder>\") — makes it easy to depend on all grants."
  value       = keys(google_secret_manager_secret_iam_member.accessor)
}
