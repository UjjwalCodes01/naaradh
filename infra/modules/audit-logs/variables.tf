variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "bucket_name" {
  description = "Audit log bucket name (<project>-audit-logs)."
  type        = string
}

variable "key_ring_id" {
  description = "KMS key ring (modules/kms) the bucket's `audit` key is created on."
  type        = string
}

variable "gcs_service_agent" {
  description = "Email of the project's Cloud Storage service agent; it gets encrypter/decrypter on the audit key."
  type        = string
}

variable "key_rotation_period" {
  description = "Automatic rotation period of the audit key (90 days, same as modules/kms)."
  type        = string
  default     = "7776000s"
}

variable "data_access_logging" {
  description = "Enable Data Access (DATA_READ + DATA_WRITE) audit logs for var.data_access_services. Admin Activity logs are always on regardless. Off in dev (cost), on in stage and prod."
  type        = bool
  default     = true
}

variable "data_access_services" {
  description = "Services whose Data Access logs are enabled when data_access_logging is true."
  type        = list(string)
  default = [
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "cloudkms.googleapis.com",
    "bigquery.googleapis.com",
    "iap.googleapis.com",
  ]
}

variable "retention_days" {
  description = "Bucket retention policy: no object can be deleted or overwritten for this many days. 365 (SPEC §6.4). Must be below the 400-day lifecycle delete."
  type        = number
  default     = 365
  validation {
    condition     = var.retention_days >= 1 && var.retention_days < 400
    error_message = "retention_days must be between 1 and 399 (objects are lifecycle-deleted at 400 days)."
  }
}

variable "lock_retention" {
  description = <<-EOT
    Lock the retention policy (GCS Bucket Lock). IRREVERSIBLE: once locked, the policy can never
    be removed or shortened, and the bucket cannot be deleted until every object has aged past it.
    Default false; true only for production.
  EOT
  type        = bool
  default     = false
}

variable "labels" {
  description = "Extra labels on the bucket (provider default_labels are applied on top)."
  type        = map(string)
  default     = {}
}
