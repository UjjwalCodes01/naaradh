variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "repository_id" {
  type    = string
  default = "naaradh"
}

variable "keep_versions" {
  description = "Most recent versions kept per image regardless of age (rollback window)."
  type        = number
  default     = 30
}

variable "cleanup_dry_run" {
  description = "true = cleanup policies only log. Flip to false after reviewing what they would delete."
  type        = bool
  default     = true
}

variable "writers" {
  description = "Members with roles/artifactregistry.writer, keyed by a static label."
  type        = map(string)
  default     = {}
}

variable "readers" {
  description = "Members with roles/artifactregistry.reader, keyed by a static label."
  type        = map(string)
  default     = {}
}
