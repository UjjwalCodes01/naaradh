output "bucket_name" {
  description = "The locked audit-log bucket."
  value       = google_storage_bucket.audit.name
}

output "sink_writer_identity" {
  description = "Service account the log sink writes as (objectCreator on the bucket only)."
  value       = google_logging_project_sink.audit.writer_identity
}

output "kms_key_id" {
  description = "CMEK protecting the audit bucket."
  value       = google_kms_crypto_key.audit.id
}

output "data_access_services" {
  description = "Services with Data Access audit logs enabled in this environment (empty when off)."
  value       = sort(tolist(local.data_access_services))
}
