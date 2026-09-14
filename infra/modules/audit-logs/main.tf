# Cloud Audit Logs exported to a locked bucket (P3-INF-5; SPEC §6.4 "Audit logs", §14).
#
#   Admin Activity   always on, free, cannot be turned off — every IAM change, secret version
#                    added, bucket or service created. Nothing to configure here.
#   System Event     always on, free.
#   Data Access      OFF by default in GCP (BigQuery is the exception: always on, free). This
#                    module turns on DATA_READ + DATA_WRITE for the services that hold or unlock
#                    customer data, so that "who read what" is answerable after an incident:
#                      secretmanager   every accessSecretVersion — which identity read which key
#                      storage         every object read/write: the recordings bucket (the
#                                      evidence trail behind AGENTS.md §11 "access to recordings
#                                      … is audited"), the state bucket, this bucket
#                      cloudkms        every encrypt/decrypt with the CMEK keys
#                      bigquery        always on anyway; listed so the intent is explicit
#                      iap             every request admitted to the staff console
#
# Cost trade-off: Data Access entries are ordinary log ingestion — they land in the _Default
# bucket (Cloud Logging: first 50 GiB/project/month free, then per GiB; 30-day retention) AND are
# copied by the sink below to GCS (routing is free; GCS storage is billed, cents per GiB-month).
# storage DATA_READ is the noisy one (one entry per object read, including signed-URL playback and
# every Terraform state read); at Naaradh's call volumes this is single-digit GiB per month.
# Dev turns Data Access off (var.data_access_logging = false). Stage and prod keep it on so the
# trail examined after an incident is the same one that was exercised in stage.

locals {
  data_access_services = var.data_access_logging ? toset(var.data_access_services) : toset([])
}

resource "google_project_iam_audit_config" "data_access" {
  for_each = local.data_access_services

  project = var.project_id
  service = each.key

  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

# ---------------------------------------------------------------------------------------------
# CMEK for the audit bucket: its own key on the environment's key ring, same pattern as
# modules/kms (90-day rotation, SOFTWARE, prevent_destroy), so it can be revoked independently of
# the recordings and analytics keys. The GCS service agent must be able to use it before the
# bucket is created.
# ---------------------------------------------------------------------------------------------
resource "google_kms_crypto_key" "audit" {
  name            = "audit"
  key_ring        = var.key_ring_id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = var.key_rotation_period

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "gcs" {
  crypto_key_id = google_kms_crypto_key.audit.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${var.gcs_service_agent}"
}

# ---------------------------------------------------------------------------------------------
# The bucket. Uniform access, public access prevention, CMEK, and a retention policy: no object
# can be deleted or overwritten for retention_days, by anyone, including a project owner. With
# is_locked = true even the policy itself can never be shortened or removed (irreversible —
# prod only, see var.lock_retention). Lifecycle deletes objects after 400 days, i.e. once they
# are past the retention period.
#
# Object Versioning is OFF: GCS does not allow a retention policy and Object Versioning on the
# same bucket (they are mutually exclusive), and the retention policy already guarantees what
# versioning would (nothing can be overwritten or removed inside the window).
# ---------------------------------------------------------------------------------------------
resource "google_storage_bucket" "audit" {
  project                     = var.project_id
  name                        = var.bucket_name
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = merge({ purpose = "audit-logs" }, var.labels)

  encryption {
    default_kms_key_name = google_kms_crypto_key.audit.id
  }

  versioning {
    enabled = false
  }

  retention_policy {
    retention_period = var.retention_days * 24 * 60 * 60
    is_locked        = var.lock_retention
  }

  lifecycle_rule {
    condition {
      age = 400
    }
    action {
      type = "Delete"
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_kms_crypto_key_iam_member.gcs]
}

# ---------------------------------------------------------------------------------------------
# Sink: every audit log (activity, data_access, system_event, policy) → the bucket, hourly
# batches under cloudaudit.googleapis.com/<type>/YYYY/MM/DD/. The sink writes as its own
# Google-managed identity, which gets objectCreator on this bucket and nothing else.
# ---------------------------------------------------------------------------------------------
resource "google_logging_project_sink" "audit" {
  project                = var.project_id
  name                   = "audit-logs-to-gcs"
  description            = "Cloud Audit Logs (Admin Activity, Data Access, System Event, Policy) to the locked audit bucket (P3-INF-5)."
  destination            = "storage.googleapis.com/${google_storage_bucket.audit.name}"
  filter                 = "logName:\"cloudaudit.googleapis.com\""
  unique_writer_identity = true

  # The sink's own hourly object creates in this bucket are Data Access entries too; exporting
  # them would only add one self-referential object per batch. They stay in Cloud Logging.
  exclusions {
    name        = "audit-bucket-self-writes"
    description = "storage.objects.create on the audit bucket by the sink itself."
    filter      = "protoPayload.methodName=\"storage.objects.create\" AND protoPayload.resourceName:\"/buckets/${var.bucket_name}/\""
  }
}

resource "google_storage_bucket_iam_member" "sink_writer" {
  bucket = google_storage_bucket.audit.name
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.audit.writer_identity
}
