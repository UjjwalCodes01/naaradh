output "notification_channels" {
  description = "Every configured channel (what CRITICAL policies notify)."
  value       = local.channels_by_severity["CRITICAL"]
}

output "channels_by_severity" {
  description = "Channel ids by policy severity: CRITICAL pages every channel, ERROR/WARNING email only."
  value       = local.channels_by_severity
}

output "uptime_check_ids" {
  value = { for k, v in google_monitoring_uptime_check_config.healthz : k => v.uptime_check_id }
}
