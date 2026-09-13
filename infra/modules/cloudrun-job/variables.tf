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

variable "command" {
  type    = list(string)
  default = null
}

variable "args" {
  type    = list(string)
  default = null
}

variable "service_account_email" {
  type = string
}

variable "timeout" {
  type    = string
  default = "600s"
}

variable "env" {
  type    = map(string)
  default = {}
}

variable "secret_env" {
  type    = list(string)
  default = []
}

variable "network" {
  type = string
}

variable "subnetwork" {
  type = string
}

variable "deletion_protection" {
  type = bool
}

variable "labels" {
  type    = map(string)
  default = {}
}
