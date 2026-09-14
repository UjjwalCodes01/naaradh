# Analytics dataset (P2-INF-2): daily call facts per tenant for RTO analytics and billing
# reconciliation reporting. Data region, CMEK, no default table expiration.
#
# PII rule (invariant 8): no phone number, hash, name, address or transcript text is ever
# exported here. Geography is coarse — a pincode BAND and a state — never a pincode.

resource "google_bigquery_dataset" "analytics" {
  project                    = var.project_id
  dataset_id                 = var.dataset_id
  location                   = var.region
  description                = "Naaradh daily call facts. No PII: no phone numbers, hashes, names, addresses or transcripts."
  delete_contents_on_destroy = false

  default_encryption_configuration {
    kms_key_name = var.kms_key_id
  }
}

resource "google_bigquery_table" "daily_call_facts" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.analytics.dataset_id
  table_id            = "daily_call_facts"
  description         = "One row per (tenant, day, direction, use_case, outcome, pincode_band, state)."
  deletion_protection = var.deletion_protection

  time_partitioning {
    type  = "DAY"
    field = "day"
  }

  clustering = ["tenant_id", "direction", "use_case"]

  encryption_configuration {
    kms_key_name = var.kms_key_id
  }

  schema = jsonencode([
    { name = "tenant_id", type = "STRING", mode = "REQUIRED", description = "ten_… ULID" },
    { name = "day", type = "DATE", mode = "REQUIRED", description = "Calendar day in Asia/Kolkata" },
    { name = "direction", type = "STRING", mode = "REQUIRED", description = "inbound | outbound" },
    { name = "use_case", type = "STRING", mode = "NULLABLE", description = "cod_confirmation, abandoned_cart, support, …" },
    { name = "outcome", type = "STRING", mode = "NULLABLE", description = "Outcome enum value" },
    { name = "billable", type = "BOOL", mode = "REQUIRED", description = "Invariant 11 definition" },
    { name = "attempts", type = "INT64", mode = "REQUIRED" },
    { name = "human_speech_sec", type = "INT64", mode = "NULLABLE" },
    { name = "minutes", type = "INT64", mode = "NULLABLE", description = "Connected minutes, rounded up per call (inbound billing unit)" },
    { name = "amount_minor", type = "INT64", mode = "NULLABLE", description = "Billed amount in paise/cents" },
    { name = "currency", type = "STRING", mode = "NULLABLE", description = "ISO 4217" },
    { name = "pincode_band", type = "STRING", mode = "NULLABLE", description = "Coarse band (e.g. first 2 digits) — never a full pincode" },
    { name = "state", type = "STRING", mode = "NULLABLE", description = "Indian state / region name" },
  ])
}

# The exporter identity is the workers-analytics runtime service account (modules/iam): it
# loads one partition a night with load jobs (apps/workers/src/analytics/sink.ts), which need
# dataEditor on the dataset and jobUser on the project — nothing else, and nobody else writes.
resource "google_bigquery_dataset_iam_member" "exporter" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${var.exporter_email}"
}

resource "google_project_iam_member" "exporter_jobs" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${var.exporter_email}"
}
