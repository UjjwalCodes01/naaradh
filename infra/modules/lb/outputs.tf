output "ip_address" {
  description = "Point every hostname's A record here."
  value       = google_compute_global_address.lb.address
}

output "dns_records" {
  description = "Records to create when DNS is not managed from this state: A per hostname + certificate DNS authorizations."
  value = {
    a = { for h in local.hostnames : h => google_compute_global_address.lb.address }
    cert_authorizations = {
      for h, _ in local.host_ids : h => {
        name = google_certificate_manager_dns_authorization.auth[h].dns_resource_record[0].name
        type = google_certificate_manager_dns_authorization.auth[h].dns_resource_record[0].type
        data = google_certificate_manager_dns_authorization.auth[h].dns_resource_record[0].data
      }
    }
  }
}

output "backend_services" {
  value = { for k, v in google_compute_backend_service.backend : k => v.name }
}
