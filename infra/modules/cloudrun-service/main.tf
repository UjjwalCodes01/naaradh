# One Cloud Run (v2) service.
#
# Ownership split with CI: Terraform owns configuration (identity, env, secrets, scaling,
# ingress, probes, VPC egress); .github/workflows/deploy.yml owns the IMAGE
# (`gcloud run services update --image`). `image` is ignored after creation so a plan never rolls
# back a deploy; Terraform updates keep whatever image is currently serving.

resource "google_cloud_run_v2_service" "service" {
  project             = var.project_id
  name                = var.name
  location            = var.region
  ingress             = var.ingress
  deletion_protection = var.deletion_protection
  labels              = var.labels

  # true only for LB-fronted services: ingress already restricts callers to the load balancer,
  # and the LB's serverless NEG does not authenticate to Cloud Run.
  invoker_iam_disabled = var.public_invoker

  template {
    service_account                  = var.service_account_email
    timeout                          = var.timeout
    max_instance_request_concurrency = var.concurrency
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    labels                           = var.labels

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    # Direct VPC egress, ALL traffic: Redis over private services access, and every external
    # call (Neon, vendors) out through Cloud NAT's static IPs (modules/network).
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = var.network
        subnetwork = var.subnetwork
      }
    }

    containers {
      name  = var.name
      image = var.image

      ports {
        container_port = var.port
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        cpu_idle          = !var.cpu_always
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }

      # Secrets by reference; the value never passes through Terraform. Access is granted per
      # secret to this service's SA from the key-holder map (infra/locals.tf).
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

      # Startup gates traffic on /readyz (Postgres + Redis answer): a revision that cannot reach
      # its dependencies never receives a request. Liveness uses /healthz so a Neon or Redis blip
      # does not restart healthy instances (and drop live calls).
      startup_probe {
        http_get {
          path = var.startup_path
          port = var.port
        }
        initial_delay_seconds = 0
        period_seconds        = 3
        timeout_seconds       = 2
        failure_threshold     = 20
      }

      liveness_probe {
        http_get {
          path = var.liveness_path
          port = var.port
        }
        period_seconds    = 15
        timeout_seconds   = 3
        failure_threshold = 4
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image, # CI owns the image
      client,
      client_version,
      traffic, # rollbacks are `gcloud run services update-traffic` (docs/runbooks/deploy.md)
    ]
  }
}

resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = var.invokers

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service.name
  role     = "roles/run.invoker"
  member   = each.value
}
