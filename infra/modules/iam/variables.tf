variable "project_id" {
  type = string
}

variable "runtime_principals" {
  description = "Service/job keys that get a run-<key> service account (≤ 26 chars each)."
  type        = list(string)
  validation {
    condition     = alltrue([for p in var.runtime_principals : can(regex("^[a-z][a-z0-9-]{1,24}[a-z0-9]$", p))])
    error_message = "Principal keys must be lowercase and short enough for a 30-char account id (run-<key>)."
  }
}

variable "github_repo" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repo))
    error_message = "github_repo must be owner/name."
  }
}

variable "github_deploy_environment" {
  type = string
}

variable "tf_state_bucket" {
  type    = string
  default = ""
}
