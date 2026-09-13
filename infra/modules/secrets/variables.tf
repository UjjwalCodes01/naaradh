variable "project_id" {
  type = string
}

variable "project_number" {
  type = string
}

variable "region" {
  type = string
}

variable "secret_names" {
  description = "Secret ids to create (== env var names)."
  type        = list(string)
}

variable "holder_counts" {
  description = "secret → holders, only used to label each secret with how many principals can read it."
  type        = map(list(string))
  default     = {}
}

variable "grants" {
  description = "Per-secret accessor grants: { \"<SECRET>/<holder>\" = { secret, member } }."
  type = map(object({
    secret = string
    member = string
  }))
}

variable "runtime_secret_prefix" {
  description = "Name prefix of secrets the application creates at runtime."
  type        = string
  default     = "merchant-webhook-"
}

variable "runtime_secret_writers" {
  description = "Principals that create runtime secrets (api), keyed by a static label."
  type        = map(string)
  default     = {}
}

variable "runtime_secret_readers" {
  description = "Principals that read runtime secrets (workers deliveries), keyed by a static label."
  type        = map(string)
  default     = {}
}
