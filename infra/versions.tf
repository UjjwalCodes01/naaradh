# Exact provider pins (AGENTS.md §11: pin exact versions). Upgrading is its own PR: bump both
# providers together, run `terraform init -upgrade`, commit the regenerated .terraform.lock.hcl,
# and read the provider changelog for the Cloud Run / Certificate Manager / IAP resources.
# 8.x exists; this module targets the 7.x line deliberately until that review is done.
terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "7.46.1"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "7.46.1"
    }
  }
}
