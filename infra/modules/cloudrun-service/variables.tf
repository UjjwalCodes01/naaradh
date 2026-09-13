variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "name" {
  type = string
}

variable "image" {
  description = "Image used at creation; ignored afterwards (CI owns it)."
  type        = string
}

variable "service_account_email" {
  type = string
}

variable "ingress" {
  type = string
  validation {
    condition = contains([
      "INGRESS_TRAFFIC_INTERNAL_ONLY",
      "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
    ], var.ingress)
    error_message = "Services are never directly public: internal-only or internal-and-cloud-load-balancing."
  }
}

variable "port" {
  type = number
}

variable "cpu" {
  type = string
}

variable "memory" {
  type = string
}

variable "cpu_always" {
  description = "true → CPU allocated outside requests (cpu_idle = false)."
  type        = bool
}

variable "min_instances" {
  type = number
}

variable "max_instances" {
  type = number
}

variable "timeout" {
  type = string
}

variable "concurrency" {
  type = number
}

variable "env" {
  description = "Plain environment variables."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Secret names mounted as env vars of the same name (latest version)."
  type        = list(string)
  default     = []
}

variable "startup_path" {
  type    = string
  default = "/readyz"
}

variable "liveness_path" {
  type    = string
  default = "/healthz"
}

variable "network" {
  type = string
}

variable "subnetwork" {
  type = string
}

variable "public_invoker" {
  description = "Disable the run.invoker IAM check (LB-fronted public services only)."
  type        = bool
  default     = false
}

variable "invokers" {
  description = "Members granted roles/run.invoker, keyed by a static label."
  type        = map(string)
  default     = {}
}

variable "deletion_protection" {
  type = bool
}

variable "labels" {
  type    = map(string)
  default = {}
}
