output "key_ids" {
  description = "Crypto key ids by name."
  value       = { for k, v in google_kms_crypto_key.keys : k => v.id }
}

output "key_ring_id" {
  value = google_kms_key_ring.ring.id
}
