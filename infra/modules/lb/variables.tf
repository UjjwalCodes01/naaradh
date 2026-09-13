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

variable "backends" {
  description = "Public backends by service key: Cloud Run service name, hostnames, Armor policy, IAP."
  type = map(object({
    service_name    = string
    hostnames       = list(string)
    security_policy = string
    iap             = bool
  }))
  validation {
    condition     = length(var.backends) > 0
    error_message = "The load balancer needs at least one backend."
  }
}

variable "default_backend" {
  description = "Backend for requests whose Host matches no rule."
  type        = string
  default     = "api"
}

variable "iap_members" {
  description = "Members granted roles/iap.httpsResourceAccessor on IAP-protected backends."
  type        = list(string)
  default     = []
}

variable "log_sample_rate" {
  type    = number
  default = 1.0
}

variable "dns_managed_zone" {
  type    = string
  default = ""
}

variable "dns_project" {
  type    = string
  default = null
}
