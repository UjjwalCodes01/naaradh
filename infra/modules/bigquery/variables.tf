variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "dataset_id" {
  type    = string
  default = "naaradh_analytics"
}

variable "kms_key_id" {
  description = "CMEK for the dataset (the BigQuery encryption service account must hold encrypterDecrypter on it first)."
  type        = string
}

variable "deletion_protection" {
  type = bool
}
