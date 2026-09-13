# Customer-managed encryption keys (CMEK) in the data region. Recordings buckets require CMEK by
# org policy (infra/README.md); BigQuery analytics uses its own key so the two can be revoked
# independently. Keys rotate every 90 days; old versions stay enabled to decrypt old objects.
#
# KMS key rings and keys cannot be deleted in GCP — `terraform destroy` only schedules key
# version destruction, which would make every recording unreadable. prevent_destroy is on.

resource "google_kms_key_ring" "ring" {
  project  = var.project_id
  name     = var.key_ring_name
  location = var.region

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key" "keys" {
  for_each = toset(var.key_names)

  name            = each.key
  key_ring        = google_kms_key_ring.ring.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = var.rotation_period

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Service agents that encrypt/decrypt on our behalf (GCS for the recordings bucket, BigQuery
# for the analytics dataset). Granted per key, never on the key ring or project.
resource "google_kms_crypto_key_iam_member" "agents" {
  for_each = var.encrypter_grants

  crypto_key_id = google_kms_crypto_key.keys[each.value.key].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = each.value.member
}
