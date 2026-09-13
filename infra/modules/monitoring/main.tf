# Uptime checks, log-based alerts and a few metric alerts (P1B-OPS-2 / P2-OPS-2, partial).
#
# Log formats (why the filters look the way they do):
#   workers        packages/shared/src/logger.ts — pino with `severity` (Cloud Logging severity)
#                  and `message`  → LogEntry.severity, jsonPayload.message
#   api/hooks/voice Fastify's pino via fastifyLoggerOptions() — `severity` plus numeric `level`
#                  (50 = error, 60 = fatal) and `msg` → match jsonPayload.level / .msg
# Filters on a specific message therefore match either field.

locals {
  channels = var.alert_email == "" ? [] : [google_monitoring_notification_channel.email[0].id]
}

resource "google_monitoring_notification_channel" "email" {
  count = var.alert_email == "" ? 0 : 1

  project      = var.project_id
  display_name = "Naaradh on-call (${var.env})"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

# ---------------------------------------------------------------------------------------------
# Uptime: GET https://<host>/healthz through the load balancer (tests DNS, TLS, Armor, LB, Run).
# ---------------------------------------------------------------------------------------------
resource "google_monitoring_uptime_check_config" "healthz" {
  for_each = var.uptime_hosts

  project      = var.project_id
  display_name = "${var.env} ${each.key} /healthz"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path           = "/healthz"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = each.value
    }
  }
}

resource "google_monitoring_alert_policy" "uptime" {
  for_each = var.uptime_hosts

  project      = var.project_id
  display_name = "[${var.env}] ${each.key} is down (/healthz failing)"
  combiner     = "OR"
  severity     = "CRITICAL"

  conditions {
    display_name = "${each.key} uptime check failing from 2+ regions"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.healthz[each.key].uptime_check_id}\""
      duration        = "120s"
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "https://${each.value}/healthz is failing. Check the service's latest revision (`gcloud run services describe ${each.key}`), roll back per docs/runbooks/deploy.md if a deploy just happened."
    mime_type = "text/markdown"
  }

  notification_channels = local.channels
}

# ---------------------------------------------------------------------------------------------
# Log-match alerts: one per event the code logs as needing a human.
# ---------------------------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "log_match" {
  for_each = var.log_alerts

  project      = var.project_id
  display_name = "[${var.env}] ${each.value.summary}"
  combiner     = "OR"
  severity     = each.value.severity

  conditions {
    display_name = each.value.summary
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND (jsonPayload.message:\"${each.value.match}\" OR jsonPayload.msg:\"${each.value.match}\")"
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }

  documentation {
    content   = "Log line matched: \"${each.value.match}\". Runbook: docs/runbooks/${each.value.runbook}"
    mime_type = "text/markdown"
  }

  notification_channels = local.channels
}

# ---------------------------------------------------------------------------------------------
# Error-rate metrics
# ---------------------------------------------------------------------------------------------
resource "google_logging_metric" "worker_errors" {
  project     = var.project_id
  name        = "naaradh/worker_errors"
  description = "ERROR+ log entries from workers-* services (pass failed, crashed, nack)."
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name:\"workers-\" AND severity>=ERROR"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "service"
      value_type = "STRING"
    }
  }

  label_extractors = {
    service = "EXTRACT(resource.labels.service_name)"
  }
}

resource "google_logging_metric" "service_errors" {
  project     = var.project_id
  name        = "naaradh/service_errors"
  description = "Fastify error/fatal entries (pino level >= 50) from api, hooks and voice."
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=(\"api\" OR \"hooks\" OR \"voice\") AND jsonPayload.level>=50"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "service"
      value_type = "STRING"
    }
  }

  label_extractors = {
    service = "EXTRACT(resource.labels.service_name)"
  }
}

resource "google_monitoring_alert_policy" "error_rate" {
  for_each = {
    workers  = { metric = google_logging_metric.worker_errors.name, threshold = var.worker_error_threshold }
    services = { metric = google_logging_metric.service_errors.name, threshold = var.service_error_threshold }
  }

  project      = var.project_id
  display_name = "[${var.env}] ${each.key}: error logs above ${each.value.threshold} / 10 min"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "${each.key} error log rate"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${each.value.metric}\" AND resource.type=\"cloud_run_revision\""
      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = each.value.threshold
      aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.service"]
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Sustained error logs. Filter Logs Explorer by the service label; worker loops log '<role> pass failed' with the error."
    mime_type = "text/markdown"
  }

  notification_channels = local.channels
}

# ---------------------------------------------------------------------------------------------
# Pub/Sub dead letters: any message there is an event no worker could process in 10 attempts.
# ---------------------------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "dead_letters" {
  count = length(var.dead_letter_subscriptions) == 0 ? 0 : 1

  project      = var.project_id
  display_name = "[${var.env}] Pub/Sub dead letters waiting"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "undelivered messages on a *.dlq.hold subscription"
    condition_threshold {
      filter          = "metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" AND resource.type=\"pubsub_subscription\" AND resource.label.subscription_id=monitoring.regex.full_match(\".*\\\\.dlq\\\\.hold\")"
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Events dead-lettered after 10 delivery attempts. Pull from the .dlq.hold subscription, fix the cause, re-publish to the source topic (docs/runbooks/deploy.md 'Dead letters')."
    mime_type = "text/markdown"
  }

  notification_channels = local.channels
}

# ---------------------------------------------------------------------------------------------
# Redis runs with maxmemory-policy=noeviction: running out of memory fails writes loudly.
# ---------------------------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "redis_memory" {
  project      = var.project_id
  display_name = "[${var.env}] Redis memory above 80%"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "Memorystore memory usage ratio"
    condition_threshold {
      filter          = "metric.type=\"redis.googleapis.com/stats/memory/usage_ratio\" AND resource.type=\"redis_instance\""
      duration        = "600s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Redis is configured never to evict (kill switches, counters). Scale memory_size_gb in infra/envs/<env>.tfvars before it fills."
    mime_type = "text/markdown"
  }

  notification_channels = local.channels
}
