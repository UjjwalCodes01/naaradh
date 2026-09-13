output "dataset_id" {
  value = google_bigquery_dataset.analytics.dataset_id
}

output "exporter_email" {
  value = google_service_account.exporter.email
}
