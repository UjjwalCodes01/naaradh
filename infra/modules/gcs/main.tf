# Recordings and transcripts bucket (SPEC §6.3): data region, CMEK (org policy), uniform
# bucket-level access, public access prevention enforced, no versioning.
#
# Retention is the application's job: the retention worker deletes media per tenant
# retention_days (30–365) and on erasure requests (AGENTS.md §4). The lifecycle rule here is only
# a safety net for anything the worker missed — 400 days is past the 365-day maximum.

resource "google_storage_bucket" "recordings" {
  project                     = var.project_id
  name                        = var.bucket_name
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  encryption {
    default_kms_key_name = var.kms_key_id
  }

  versioning {
    enabled = false
  }

  soft_delete_policy {
    retention_duration_seconds = var.soft_delete_seconds
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
}

resource "google_storage_bucket_iam_member" "members" {
  for_each = var.iam

  bucket = google_storage_bucket.recordings.name
  role   = each.value.role
  member = each.value.member
}
