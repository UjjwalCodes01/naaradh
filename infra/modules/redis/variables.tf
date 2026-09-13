variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "name" {
  type    = string
  default = "naaradh"
}

variable "network_id" {
  type = string
}

variable "tier" {
  type = string
  validation {
    condition     = contains(["BASIC", "STANDARD_HA"], var.tier)
    error_message = "tier must be BASIC or STANDARD_HA."
  }
}

variable "memory_size_gb" {
  type = number
}

variable "redis_version" {
  type = string
}
