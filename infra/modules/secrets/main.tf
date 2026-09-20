# Secret Manager: EMPTY secret containers plus per-secret IAM. Terraform never sees a secret
# value — humans add versions (docs/runbooks/deploy.md "Secrets"), so no value ever lands in
# state, plan output or CI logs.
#
# Replication is user-managed in the data region: automatic replication would store copies
# outside India, which the org location policy forbids (infra/README.md).

resource "google_secret_manager_secret" "secret" {
  for_each = toset(var.secret_names)

  project   = var.project_id
  secret_id = each.key

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  labels = { holder_count = tostring(length(lookup(var.holder_counts, each.key, []))) }
}

# One binding per (secret, service account): roles/secretmanager.secretAccessor on the SECRET,
# never on the project. The map comes from the key-holder map in infra/locals.tf.
resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = var.grants

  project   = var.project_id
  secret_id = google_secret_manager_secret.secret[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value.member
}

# ---------------------------------------------------------------------------------------------
# Secrets created at RUNTIME: merchant webhook signing secrets.
#
# api (POST /v1/webhooks, api/src/secrets.ts) creates `merchant-webhook-<whk_id>` and
# adds a version; the deliveries worker reads it back to sign each delivery
# (workers/src/deliveries/secrets.ts). Neither can be granted on the secret itself because it
# does not exist yet, and `secretmanager.secrets.create` is checked on the PROJECT (the parent).
# So both bindings are project-level, narrowed by an IAM condition on the resource name prefix.
#
# Trade-off: a project-level binding is broader than a per-secret one; the condition is what keeps
# api and deliveries away from DATABASE_*, the phone keys, etc. The condition uses the project
# NUMBER because Secret Manager resource names are number-based.
# [VERIFY] before relying on it in prod: how the condition evaluates for the CREATE call (the
# checked resource.name may be the parent project rather than the new secret's name). If api gets
# PERMISSION_DENIED on createSecret in stage, split `secretmanager.secrets.create` into an
# unconditional binding of a create-only role — create alone reads nothing and cannot add
# versions to existing secrets — and keep versions.add under the condition.
# ---------------------------------------------------------------------------------------------
resource "google_project_iam_custom_role" "runtime_secret_writer" {
  project     = var.project_id
  role_id     = "naaradhRuntimeSecretWriter"
  title       = "Naaradh runtime secret writer"
  description = "Create secrets and add versions; bound only with a name-prefix condition."
  permissions = [
    "secretmanager.secrets.create",
    "secretmanager.secrets.get",
    "secretmanager.versions.add",
  ]
}

resource "google_project_iam_member" "runtime_secret_writer" {
  for_each = var.runtime_secret_writers

  project = var.project_id
  role    = google_project_iam_custom_role.runtime_secret_writer.id
  member  = each.value

  condition {
    title       = "only-${var.runtime_secret_prefix}"
    description = "Runtime-created merchant webhook secrets only"
    expression  = "resource.name.startsWith(\"projects/${var.project_number}/secrets/${var.runtime_secret_prefix}\")"
  }
}

resource "google_project_iam_member" "runtime_secret_reader" {
  for_each = var.runtime_secret_readers

  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = each.value

  condition {
    title       = "only-${var.runtime_secret_prefix}"
    description = "Runtime-created merchant webhook secrets only"
    expression  = "resource.name.startsWith(\"projects/${var.project_number}/secrets/${var.runtime_secret_prefix}\")"
  }
}
