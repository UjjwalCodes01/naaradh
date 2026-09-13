# Identities.
#
#   run-<service>   one runtime service account per Cloud Run service / job. No project-level
#                   roles at all: every permission is granted on the specific secret, topic,
#                   subscription or bucket (see secrets, pubsub, gcs modules and infra/main.tf).
#   deployer        used by .github/workflows/deploy.yml through Workload Identity Federation:
#                   push images, update Cloud Run services/jobs, run the migrate job. It can act
#                   as the runtime SAs (to deploy them) and nothing else. It CANNOT change IAM,
#                   secrets or infrastructure — Terraform is applied by a human (AGENTS.md §1).
#   tf-planner      used by the PR `terraform plan` job: read-only.

resource "google_service_account" "runtime" {
  for_each = toset(var.runtime_principals)

  project      = var.project_id
  account_id   = "run-${each.key}"
  display_name = "Cloud Run runtime: ${each.key}"
  description  = "Runtime identity for ${each.key}. Grants are per resource (infra/locals.tf key-holder map)."
}

# ---------------------------------------------------------------------------------------------
# Workload Identity Federation for GitHub Actions
# ---------------------------------------------------------------------------------------------
resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  description               = "OIDC tokens from GitHub Actions for ${var.github_repo}"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "GitHub Actions OIDC"

  attribute_mapping = {
    "google.subject"         = "assertion.sub"
    "attribute.repository"   = "assertion.repository"
    "attribute.ref"          = "assertion.ref"
    "attribute.environment"  = "assertion.environment"
    "attribute.event_name"   = "assertion.event_name"
    "attribute.workflow_ref" = "assertion.job_workflow_ref"
  }

  # Only this repository can exchange a token at all — forks and other repos are rejected here,
  # before any service-account binding is considered.
  attribute_condition = "assertion.repository == \"${var.github_repo}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

locals {
  pool_name = google_iam_workload_identity_pool.github.name
}

# ---------------------------------------------------------------------------------------------
# Deployer
# ---------------------------------------------------------------------------------------------
resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = "deployer"
  display_name = "GitHub Actions deployer (${var.github_deploy_environment})"
  description  = "Pushes images and rolls Cloud Run revisions. Cannot change IAM or infrastructure."
}

# Only jobs running in the named GitHub environment (protected: branch rules / reviewers) may
# impersonate the deployer. The OIDC subject for such jobs is repo:<repo>:environment:<env>.
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${local.pool_name}/subject/repo:${var.github_repo}:environment:${var.github_deploy_environment}"
}

resource "google_project_iam_member" "deployer_run" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# actAs on each runtime SA (required to deploy a revision that runs as it) — resource-level.
resource "google_service_account_iam_member" "deployer_act_as" {
  for_each = google_service_account.runtime

  service_account_id = each.value.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# ---------------------------------------------------------------------------------------------
# Read-only planner (PR `terraform plan`)
# ---------------------------------------------------------------------------------------------
resource "google_service_account" "planner" {
  project      = var.project_id
  account_id   = "tf-planner"
  display_name = "Terraform plan (read-only)"
  description  = "PR plan job. Reads resource metadata and IAM policies; cannot read secret values."
}

resource "google_service_account_iam_member" "planner_wif" {
  service_account_id = google_service_account.planner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.pool_name}/attribute.repository/${var.github_repo}"
}

resource "google_project_iam_member" "planner" {
  for_each = toset([
    "roles/viewer",               # resource metadata (no secret payloads)
    "roles/iam.securityReviewer", # IAM policies on every resource Terraform manages
  ])

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.planner.email}"
}

# Refreshing google_redis_instance with AUTH on reads the AUTH string. The same value is in the
# state file the planner already reads, so this adds no exposure beyond state access; the
# instance is only reachable from inside the VPC.
resource "google_project_iam_custom_role" "planner_extras" {
  project     = var.project_id
  role_id     = "naaradhTfPlannerExtras"
  title       = "Terraform planner extras"
  description = "Permissions a read-only terraform plan needs beyond roles/viewer."
  permissions = ["redis.instances.getAuthString"]
}

resource "google_project_iam_member" "planner_extras" {
  project = var.project_id
  role    = google_project_iam_custom_role.planner_extras.id
  member  = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_storage_bucket_iam_member" "planner_state" {
  count = var.tf_state_bucket == "" ? 0 : 1

  bucket = var.tf_state_bucket
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.planner.email}"
}
