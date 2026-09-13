output "policy_ids" {
  description = "Security policy self links by key."
  value       = { for k, v in google_compute_security_policy.policy : k => v.self_link }
}
