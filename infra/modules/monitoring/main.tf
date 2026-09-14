# Uptime checks, log-based alerts, Cloud Run SLO alerts and a few metric alerts
# (P1B-OPS-2 / P2-OPS-2; on-call channels and SLOs: P3-OPS-1).
#
# Log formats (why the filters look the way they do):
#   workers        packages/shared/src/logger.ts — pino with `severity` (Cloud Logging severity)
#                  and `message`  → LogEntry.severity, jsonPayload.message
#   api/hooks/voice Fastify's pino via fastifyLoggerOptions() — `severity` plus numeric `level`
#                  (50 = error, 60 = fatal) and `msg` → match jsonPayload.level / .msg
# Filters on a specific message therefore match either field.
#
# Who gets told (P3-OPS-1): CRITICAL policies notify every configured channel — email plus the
# optional PagerDuty and webhook (Better Stack-style) channels, i.e. they page; ERROR and WARNING
# policies go to the mailbox only. Every policy's documentation names its runbook under
# docs/runbooks/ (README.md there is the index).

locals {
  email_channel     = var.alert_email == "" ? [] : [google_monitoring_notification_channel.email[0].id]
  pagerduty_channel = var.pagerduty_service_key == "" ? [] : [google_monitoring_notification_channel.pagerduty[0].id]
  webhook_channel   = var.alert_webhook_url == "" ? [] : [google_monitoring_notification_channel.webhook[0].id]

  channels_by_severity = {
    CRITICAL = concat(local.email_channel, local.pagerduty_channel, local.webhook_channel)
    ERROR    = local.email_channel
    WARNING  = local.email_channel
  }
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

# PagerDuty Events API v2 integration key of the on-call service. Sensitive: the API never
# returns it, Terraform keeps it in state (the state bucket is locked down for this reason).
resource "google_monitoring_notification_channel" "pagerduty" {
  count = var.pagerduty_service_key == "" ? 0 : 1

  project      = var.project_id
  display_name = "Naaradh PagerDuty (${var.env})"
  type         = "pagerduty"

  sensitive_labels {
    service_key = var.pagerduty_service_key
  }
}

# Generic token-in-URL webhook (Better Stack, Opsgenie, Zenduty, … all expose one). The URL
# carries the token, so it is sensitive too.
resource "google_monitoring_notification_channel" "webhook" {
  count = var.alert_webhook_url == "" ? 0 : 1

  project      = var.project_id
  display_name = "Naaradh on-call webhook (${var.env})"
  type         = "webhook_tokenauth"
  labels = {
    url = var.alert_webhook_url
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
    content   = "https://${each.value}/healthz is failing. Check the service's latest revision (`gcloud run services describe ${each.key}`); if a deploy just happened, roll back. Runbook: docs/runbooks/deploy.md (\"Roll back a service\")."
    mime_type = "text/markdown"
  }

  notification_channels = local.channels_by_severity["CRITICAL"]
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
    content   = "Log line matched: \"${each.value.match}\". Runbook: docs/runbooks/${each.value.runbook}${each.value.section == "" ? "" : " (\"${each.value.section}\")"}"
    mime_type = "text/markdown"
  }

  notification_channels = local.channels_by_severity[each.value.severity]
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
    content   = "Sustained error logs. Filter Logs Explorer by the service label; worker loops log '<role> pass failed' with the error. Runbook: docs/runbooks/deploy.md (\"After every deploy — check\", then \"Roll back a service\" if a deploy caused it)."
    mime_type = "text/markdown"
  }

  notification_channels = local.channels_by_severity["ERROR"]
}

# ---------------------------------------------------------------------------------------------
# Cloud Run SLOs (SPEC §6.8, AGENTS.md §13): only for services that exist in this environment.
#   hooks   webhook ack p99 < 800 ms — above it Shopify/engines start retrying deliveries
#   voice   inbound context + tool calls p95 < 700 ms — above it the engine times out mid-call
#           and the caller hears dead air or the fallback (ADR-0006)
#   5xx     api / hooks / voice: more than 2% of requests failing is an incident
# request_latencies is a DISTRIBUTION: ALIGN_DELTA per revision, then the percentile across the
# service's revisions. Both counts in the 5xx ratio use the same alignment and grouping.
# ---------------------------------------------------------------------------------------------
locals {
  latency_slos = {
    for k, v in {
      hooks = {
        percentile   = 99
        threshold_ms = var.slo.hooks_p99_ms
        severity     = "ERROR"
        what         = "webhook ack SLO (SPEC §6.8: p99 < 800 ms). Shopify and the engines retry slow deliveries; sustained breaches lose events."
        runbook      = "docs/runbooks/deploy.md (\"After every deploy — check\"; roll back if a deploy caused it)"
      }
      voice = {
        percentile   = 95
        threshold_ms = var.slo.voice_p95_ms
        severity     = "CRITICAL"
        what         = "inbound-context and mid-call tool budget (ADR-0006: p95 < 700 ms). Above it the engine times out and callers hear dead air or the fallback."
        runbook      = "docs/runbooks/inbound-fallback.md, then docs/runbooks/deploy.md (\"Roll back a service\")"
      }
    } : k => v if contains(var.run_services, k)
  }

  error_ratio_services = toset([for s in ["api", "hooks", "voice"] : s if contains(var.run_services, s)])

  # Monitoring filter regex literal: "." must reach the API as "\." (HCL "\\\\." → string "\\." →
  # filter-literal unescape "\.").
  subscription_regex = join("|", [for s in var.subscriptions : replace(s, ".", "\\\\.")])
}

resource "google_monitoring_alert_policy" "run_latency" {
  for_each = local.latency_slos

  project      = var.project_id
  display_name = "[${var.env}] ${each.key}: p${each.value.percentile} latency above ${each.value.threshold_ms} ms"
  combiner     = "OR"
  severity     = each.value.severity

  conditions {
    display_name = "${each.key} p${each.value.percentile} request latency over 5 min"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_latencies\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${each.key}\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = each.value.threshold_ms
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_PERCENTILE_${each.value.percentile}"
        group_by_fields      = ["resource.label.service_name"]
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "${each.key} is breaching its ${each.value.what} Check the latest revision's CPU/instance graphs and Neon/Redis latency; scale (min instances) or roll back. Runbook: ${each.value.runbook}."
    mime_type = "text/markdown"
  }

  notification_channels = local.channels_by_severity[each.value.severity]
}

resource "google_monitoring_alert_policy" "run_5xx_ratio" {
  for_each = local.error_ratio_services

  project      = var.project_id
  display_name = "[${var.env}] ${each.key}: 5xx above ${var.slo.error_ratio * 100}% of requests"
  combiner     = "OR"
  severity     = "CRITICAL"

  conditions {
    display_name = "${each.key} 5xx / all requests over 5 min"
    condition_threshold {
      filter             = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${each.key}\" AND metric.label.response_code_class=\"5xx\""
      denominator_filter = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${each.key}\""
      duration           = "300s"
      comparison         = "COMPARISON_GT"
      threshold_value    = var.slo.error_ratio
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
      denominator_aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "More than ${var.slo.error_ratio * 100}% of ${each.key} requests returned 5xx for 5 minutes. Read the error logs (jsonPayload.level >= 50), check Neon/Redis/engine reachability; if a deploy just happened, roll back. Runbook: docs/runbooks/deploy.md (\"After every deploy — check\", \"Roll back a service\"); engine failures: docs/runbooks/engine-outage.md."
    mime_type = "text/markdown"
  }

  notification_channels = local.channels_by_severity["CRITICAL"]
}

# ---------------------------------------------------------------------------------------------
# Pub/Sub backlog on the worker subscriptions: a message older than 5 minutes means the consumer
# is down, stuck, or retrying a poison message (ordering keys hold a tenant's later events behind
# it until it dead-letters).
# ---------------------------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "subscription_backlog" {
  count = length(var.subscriptions) == 0 ? 0 : 1

  project      = var.project_id
  display_name = "[${var.env}] Pub/Sub backlog: oldest unacked message older than ${var.slo.backlog_age_seconds} s"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "oldest_unacked_message_age on a worker subscription"
    condition_threshold {
      filter          = "metric.type=\"pubsub.googleapis.com/subscription/oldest_unacked_message_age\" AND resource.type=\"pubsub_subscription\" AND resource.label.subscription_id=monitoring.regex.full_match(\"${local.subscription_regex}\")"
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = var.slo.backlog_age_seconds
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
    content   = "A worker subscription is not draining. Check the consumer service is Ready and its logs for 'handler failed; nack' (a poison message will dead-letter after 10 attempts). Runbook: docs/runbooks/deploy.md (\"After every deploy — check\", \"Dead letters\")."
    mime_type = "text/markdown"
  }

  notification_channels = local.channels_by_severity["ERROR"]
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
    content   = "Events dead-lettered after 10 delivery attempts. Pull from the .dlq.hold subscription, fix the cause, re-publish to the source topic. Runbook: docs/runbooks/deploy.md (\"Dead letters\")."
    mime_type = "text/markdown"
  }

  notification_channels = local.channels_by_severity["ERROR"]
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
    content   = "Redis is configured never to evict (kill switches, counters). Scale memory_size_gb in infra/envs/<env>.tfvars before it fills. Runbook: docs/runbooks/deploy.md (\"Apply Terraform\")."
    mime_type = "text/markdown"
  }

  notification_channels = local.channels_by_severity["WARNING"]
}
