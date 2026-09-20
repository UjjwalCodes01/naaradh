# Docker repository for the service images: <region>-docker.pkg.dev/<project>/<repository_id>/<app>:<git-sha>
#
# Tags are immutable: a git SHA always means the same bytes, so a rollback to "abc123" is a
# rollback to exactly what ran before. CI skips the build when the tag already exists.

resource "google_artifact_registry_repository" "docker" {
  project       = var.project_id
  location      = var.region
  repository_id = var.repository_id
  description   = "Naaradh service images (*/Dockerfile), tagged by git SHA"
  format        = "DOCKER"

  docker_config {
    immutable_tags = true
  }

  # Keep enough history to roll back; delete untagged layers left by failed pushes. Starts in
  # dry-run so the first weeks show what WOULD be deleted (Cloud Logging) before anything is.
  cleanup_policy_dry_run = var.cleanup_dry_run

  cleanup_policies {
    id     = "keep-recent-versions"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.keep_versions
    }
  }

  cleanup_policies {
    id     = "delete-old-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "1209600s" # 14 days
    }
  }
}

# The deploy identity pushes. Cloud Run pulls same-project images with its own service agent, so
# runtime service accounts need nothing here; `readers` exists for a future cross-project pull
# (e.g. promoting stage digests into prod).
resource "google_artifact_registry_repository_iam_member" "writers" {
  for_each = var.writers

  project    = var.project_id
  location   = google_artifact_registry_repository.docker.location
  repository = google_artifact_registry_repository.docker.name
  role       = "roles/artifactregistry.writer"
  member     = each.value
}

resource "google_artifact_registry_repository_iam_member" "readers" {
  for_each = var.readers

  project    = var.project_id
  location   = google_artifact_registry_repository.docker.location
  repository = google_artifact_registry_repository.docker.name
  role       = "roles/artifactregistry.reader"
  member     = each.value
}
