# VPC for Cloud Run Direct VPC egress, Cloud NAT with static egress IPs, and private services
# access for Memorystore.
#
# Egress model: every Cloud Run service and job uses Direct VPC egress with ALL_TRAFFIC, so all
# outbound traffic (Neon, Shopify, voice engines, Razorpay, Postmark) leaves through Cloud NAT on
# the static IPs below. Those IPs are what Neon's IP allow-list is set to (ADR-0004: the database
# is reached over public TLS, Singapore) and what vendors can allow-list (AGENTS.md §11).

resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = var.name
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "run" {
  project                  = var.project_id
  name                     = "${var.name}-run-${var.region}"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true # Google APIs (Pub/Sub, GCS, Secret Manager) stay on Google's network

  log_config {
    aggregation_interval = "INTERVAL_10_MIN"
    flow_sampling        = 0.1
    metadata             = "EXCLUDE_ALL_METADATA"
  }
}

resource "google_compute_router" "router" {
  project = var.project_id
  name    = "${var.name}-router-${var.region}"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_address" "nat" {
  count        = var.nat_ip_count
  project      = var.project_id
  name         = "${var.name}-nat-${var.region}-${count.index}"
  region       = var.region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"

  lifecycle {
    # Neon's allow-list and vendor allow-lists point at these; losing one is an outage.
    prevent_destroy = true
  }
}

resource "google_compute_router_nat" "nat" {
  project                             = var.project_id
  name                                = "${var.name}-nat-${var.region}"
  region                              = var.region
  router                              = google_compute_router.router.name
  nat_ip_allocate_option              = "MANUAL_ONLY"
  nat_ips                             = google_compute_address.nat[*].self_link
  source_subnetwork_ip_ranges_to_nat  = "LIST_OF_SUBNETWORKS"
  enable_dynamic_port_allocation      = true
  enable_endpoint_independent_mapping = false
  min_ports_per_vm                    = 64
  max_ports_per_vm                    = 4096

  subnetwork {
    name                    = google_compute_subnetwork.run.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# Private services access (VPC peering to Google-managed services): Memorystore today, and
# Cloud SQL Mumbai if Q-16 ever forces the documented Neon → Cloud SQL move.
resource "google_compute_global_address" "psa" {
  project       = var.project_id
  name          = "${var.name}-psa"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.psa_prefix_length
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa.name]
}

# Nothing in this VPC accepts inbound connections from the internet; the implied deny-ingress
# rule covers that. This rule only documents and logs it explicitly at low priority.
resource "google_compute_firewall" "deny_ingress" {
  project   = var.project_id
  name      = "${var.name}-deny-all-ingress"
  network   = google_compute_network.vpc.id
  direction = "INGRESS"
  priority  = 65534

  deny {
    protocol = "all"
  }
  source_ranges = ["0.0.0.0/0"]

  log_config {
    metadata = "EXCLUDE_ALL_METADATA"
  }
}
