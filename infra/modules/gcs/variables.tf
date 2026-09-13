variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "bucket_name" {
  type = string
}

variable "kms_key_id" {
  description = "CMEK for the bucket (the GCS service agent must hold encrypterDecrypter on it first)."
  type        = string
}

variable "soft_delete_seconds" {
  type = number
}

variable "iam" {
  description = "Bucket-level grants keyed by a static label: { \"api-read\" = { role, member } }."
  type = map(object({
    role   = string
    member = string
  }))
  default = {}
}
