# Global external Application Load Balancer in front of every public Cloud Run service:
#
#   hostname ──► URL map host rule ──► backend service (Cloud Armor policy, optional IAP)
#            ──► serverless NEG ──► Cloud Run service (ingress: internal + cloud load balancing)
#
# TLS: Certificate Manager, one Google-managed certificate per hostname with DNS authorization
# (issuance does not depend on the A record already pointing here, so certificates can be ready
# before cut-over). HTTP :80 only redirects to HTTPS.

locals {
  hostnames = toset(flatten([for b in values(var.backends) : b.hostnames]))
  # Certificate Manager resource names: lowercase letters, digits, hyphens.
  host_ids        = { for h in local.hostnames : h => replace(h, ".", "-") }
  default_backend = contains(keys(var.backends), var.default_backend) ? var.default_backend : sort(keys(var.backends))[0]
  iap_backends    = { for k, b in var.backends : k => b if b.iap }
  iap_grants = {
    for pair in setproduct(keys(local.iap_backends), var.iap_members) :
    "${pair[0]}/${pair[1]}" => { backend = pair[0], member = pair[1] }
  }
}

resource "google_compute_global_address" "lb" {
  project      = var.project_id
  name         = "${var.name}-lb"
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
}

# ---------------------------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------------------------
resource "google_compute_region_network_endpoint_group" "neg" {
  for_each = var.backends

  project               = var.project_id
  name                  = "${var.name}-${each.key}-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = each.value.service_name
  }
}

resource "google_compute_backend_service" "backend" {
  for_each = var.backends

  project               = var.project_id
  name                  = "${var.name}-${each.key}"
  protocol              = "HTTPS"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  security_policy       = each.value.security_policy

  backend {
    group = google_compute_region_network_endpoint_group.neg[each.key].id
  }

  log_config {
    enable      = true
    sample_rate = var.log_sample_rate
  }

  # Staff console: Identity-Aware Proxy with the Google-managed OAuth client. Access is granted
  # below to var.iap_members only.
  dynamic "iap" {
    for_each = each.value.iap ? [1] : []
    content {
      enabled = true
    }
  }
}

resource "google_iap_web_backend_service_iam_member" "access" {
  for_each = local.iap_grants

  project             = var.project_id
  web_backend_service = google_compute_backend_service.backend[each.value.backend].name
  role                = "roles/iap.httpsResourceAccessor"
  member              = each.value.member
}

# ---------------------------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------------------------
resource "google_compute_url_map" "https" {
  project         = var.project_id
  name            = "${var.name}-https"
  default_service = google_compute_backend_service.backend[local.default_backend].id

  dynamic "host_rule" {
    for_each = var.backends
    content {
      hosts        = host_rule.value.hostnames
      path_matcher = host_rule.key
    }
  }

  dynamic "path_matcher" {
    for_each = var.backends
    content {
      name            = path_matcher.key
      default_service = google_compute_backend_service.backend[path_matcher.key].id
    }
  }
}

resource "google_compute_url_map" "http_redirect" {
  project = var.project_id
  name    = "${var.name}-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

# ---------------------------------------------------------------------------------------------
# TLS
# ---------------------------------------------------------------------------------------------
resource "google_compute_ssl_policy" "modern" {
  project         = var.project_id
  name            = "${var.name}-tls12-modern"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

resource "google_certificate_manager_dns_authorization" "auth" {
  for_each = local.host_ids

  project = var.project_id
  name    = "${each.value}-auth"
  domain  = each.key
}

resource "google_certificate_manager_certificate" "cert" {
  for_each = local.host_ids

  project = var.project_id
  name    = "${each.value}-cert"

  managed {
    domains            = [each.key]
    dns_authorizations = [google_certificate_manager_dns_authorization.auth[each.key].id]
  }
}

resource "google_certificate_manager_certificate_map" "map" {
  project = var.project_id
  name    = "${var.name}-certs"
}

resource "google_certificate_manager_certificate_map_entry" "entry" {
  for_each = local.host_ids

  project      = var.project_id
  name         = "${each.value}-entry"
  map          = google_certificate_manager_certificate_map.map.name
  hostname     = each.key
  certificates = [google_certificate_manager_certificate.cert[each.key].id]
}

# ---------------------------------------------------------------------------------------------
# Frontends
# ---------------------------------------------------------------------------------------------
resource "google_compute_target_https_proxy" "https" {
  project         = var.project_id
  name            = "${var.name}-https"
  url_map         = google_compute_url_map.https.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.map.id}"
  ssl_policy      = google_compute_ssl_policy.modern.id
}

resource "google_compute_target_http_proxy" "http" {
  project = var.project_id
  name    = "${var.name}-http"
  url_map = google_compute_url_map.http_redirect.id
}

resource "google_compute_global_forwarding_rule" "https" {
  project               = var.project_id
  name                  = "${var.name}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.https.id
}

resource "google_compute_global_forwarding_rule" "http" {
  project               = var.project_id
  name                  = "${var.name}-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb.id
  port_range            = "80"
  target                = google_compute_target_http_proxy.http.id
}

# ---------------------------------------------------------------------------------------------
# DNS (optional): only when the zone is managed from here. Otherwise the records are outputs.
# ---------------------------------------------------------------------------------------------
resource "google_dns_record_set" "a" {
  for_each = var.dns_managed_zone == "" ? toset([]) : local.hostnames

  project      = coalesce(var.dns_project, var.project_id)
  managed_zone = var.dns_managed_zone
  name         = "${each.key}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.lb.address]
}

resource "google_dns_record_set" "cert_auth" {
  for_each = var.dns_managed_zone == "" ? {} : local.host_ids

  project      = coalesce(var.dns_project, var.project_id)
  managed_zone = var.dns_managed_zone
  name         = google_certificate_manager_dns_authorization.auth[each.key].dns_resource_record[0].name
  type         = google_certificate_manager_dns_authorization.auth[each.key].dns_resource_record[0].type
  ttl          = 300
  rrdatas      = [google_certificate_manager_dns_authorization.auth[each.key].dns_resource_record[0].data]
}
