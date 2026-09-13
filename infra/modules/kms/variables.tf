variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "key_ring_name" {
  type = string
}

variable "key_names" {
  type = list(string)
}

variable "rotation_period" {
  description = "Automatic rotation period (90 days)."
  type        = string
  default     = "7776000s"
}

variable "encrypter_grants" {
  description = "Service agents allowed to use a key, by a static label: { gcs = { key = \"recordings\", member = \"serviceAccount:...\" } }."
  type = map(object({
    key    = string
    member = string
  }))
  default = {}
}
