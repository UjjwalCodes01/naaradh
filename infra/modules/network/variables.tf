variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "name" {
  description = "Base name for the VPC and its resources."
  type        = string
  default     = "naaradh"
}

variable "subnet_cidr" {
  type = string
}

variable "psa_prefix_length" {
  type = number
}

variable "nat_ip_count" {
  type = number
  validation {
    condition     = var.nat_ip_count >= 1 && var.nat_ip_count <= 4
    error_message = "nat_ip_count must be 1-4 (every IP must be added to Neon's allow-list)."
  }
}
