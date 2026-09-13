output "host" {
  value = google_redis_instance.cache.host
}

output "port" {
  value = google_redis_instance.cache.port
}

output "auth_string" {
  description = "Goes into the REDIS_URL secret version (redis://:<auth>@<host>:<port>). Never printed by CI."
  value       = google_redis_instance.cache.auth_string
  sensitive   = true
}
