output "topics" {
  value = { for k, v in google_pubsub_topic.topic : k => v.name }
}

output "subscriptions" {
  value = { for k, v in google_pubsub_subscription.sub : k => v.name }
}

output "dead_letter_hold_subscriptions" {
  description = "Subscriptions holding dead letters — monitored for any backlog."
  value       = { for k, v in google_pubsub_subscription.dead_letter_hold : k => v.name }
}
