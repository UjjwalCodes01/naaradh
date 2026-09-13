# Pub/Sub topics and subscriptions for the hooks → workers event bus.
#
# Names match the code exactly (apps/hooks/src/pubsub.ts topicId, apps/workers/src/bus.ts
# subscriptionId): topic `<prefix>.<topic>`, subscription `<prefix>.<topic>.<worker>`.
# Messages carry only a webhook_events id and routing attributes — never PII (hooks pubsub.ts).
#
# Terraform owns every topic and subscription. The code's create-if-missing path only runs
# against the emulator (PUBSUB_EMULATOR_HOST), so runtime identities get publisher/subscriber on
# the specific resources and nothing that can create or delete.

locals {
  topic_ids = { for t in var.topics : t => "${var.prefix}.${t}" }
  subs = {
    for s in var.subscriptions : "${s.topic}.${s.worker}" => merge(s, {
      id = "${var.prefix}.${s.topic}.${s.worker}"
    })
  }
}

resource "google_pubsub_topic" "topic" {
  for_each = local.topic_ids

  project                    = var.project_id
  name                       = each.value
  message_retention_duration = "604800s" # 7 days: replay after a consumer bug

  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
}

# Dead-letter topic per subscription, plus a "hold" subscription on it: a topic with no
# subscription drops messages, and a dead letter nobody can read is an invisible data loss.
resource "google_pubsub_topic" "dead_letter" {
  for_each = local.subs

  project                    = var.project_id
  name                       = "${each.value.id}.dlq"
  message_retention_duration = "604800s"

  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
}

resource "google_pubsub_subscription" "dead_letter_hold" {
  for_each = local.subs

  project                    = var.project_id
  name                       = "${each.value.id}.dlq.hold"
  topic                      = google_pubsub_topic.dead_letter[each.key].id
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  retain_acked_messages      = false

  expiration_policy {
    ttl = "" # never expire
  }
}

resource "google_pubsub_subscription" "sub" {
  for_each = local.subs

  project                    = var.project_id
  name                       = each.value.id
  topic                      = google_pubsub_topic.topic[each.value.topic].id
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  retain_acked_messages      = false
  # hooks publishes with orderingKey = tenant_id; the code-side create path also enables this.
  enable_message_ordering = true

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter[each.key].id
    max_delivery_attempts = 10
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  expiration_policy {
    ttl = "" # never expire, even with no consumer for 31 days
  }
}

# ---------------------------------------------------------------------------------------------
# IAM
# ---------------------------------------------------------------------------------------------

# Publishers (hooks) on each topic.
resource "google_pubsub_topic_iam_member" "publisher" {
  for_each = {
    for pair in setproduct(keys(local.topic_ids), keys(var.publishers)) :
    "${pair[0]}/${pair[1]}" => { topic = pair[0], member = var.publishers[pair[1]] }
  }

  project = var.project_id
  topic   = google_pubsub_topic.topic[each.value.topic].name
  role    = "roles/pubsub.publisher"
  member  = each.value.member
}

# Each worker consumes its own subscription only.
resource "google_pubsub_subscription_iam_member" "subscriber" {
  for_each = local.subs

  project      = var.project_id
  subscription = google_pubsub_subscription.sub[each.key].name
  role         = "roles/pubsub.subscriber"
  member       = each.value.member
}

# Dead-lettering is done by the Pub/Sub service agent: it must publish to the DLQ and
# acknowledge (subscribe) on the source subscription.
resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  for_each = local.subs

  project = var.project_id
  topic   = google_pubsub_topic.dead_letter[each.key].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "dlq_forwarder" {
  for_each = local.subs

  project      = var.project_id
  subscription = google_pubsub_subscription.sub[each.key].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}
