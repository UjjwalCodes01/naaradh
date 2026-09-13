# A Cloud Run Job (used for `migrate`). Same ownership split as services: Terraform owns config,
# CI sets the image (`gcloud run jobs update --image`) and executes it before rolling services.

resource "google_cloud_run_v2_job" "job" {
  project             = var.project_id
  name                = var.name
  location            = var.region
  deletion_protection = var.deletion_protection
  labels              = var.labels

  template {
    task_count  = 1
    parallelism = 1
    labels      = var.labels

    template {
      service_account = var.service_account_email
      timeout         = var.timeout
      # A failed migration must be looked at by a human, not retried into a half-applied state.
      max_retries = 0

      vpc_access {
        egress = "ALL_TRAFFIC" # Neon allow-lists the Cloud NAT IPs
        network_interfaces {
          network    = var.network
          subnetwork = var.subnetwork
        }
      }

      containers {
        name    = var.name
        image   = var.image
        command = var.command
        args    = var.args

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        dynamic "env" {
          for_each = var.env
          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = toset(var.secret_env)
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.key
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image, # CI owns the image
      client,
      client_version,
    ]
  }
}
