output "notification_channels" {
  value = local.channels
}

output "uptime_check_ids" {
  value = { for k, v in google_monitoring_uptime_check_config.healthz : k => v.uptime_check_id }
}
