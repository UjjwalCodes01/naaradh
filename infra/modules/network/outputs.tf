output "network_id" {
  value = google_compute_network.vpc.id
}

output "network_name" {
  value = google_compute_network.vpc.name
}

output "subnet_id" {
  value = google_compute_subnetwork.run.id
}

output "subnet_name" {
  value = google_compute_subnetwork.run.name
}

output "nat_ips" {
  description = "Static egress IPs — put these in Neon's IP allow-list."
  value       = google_compute_address.nat[*].address
}

output "psa_connection" {
  description = "Depend on this before creating PSA-attached services (Memorystore)."
  value       = google_service_networking_connection.psa.id
}
