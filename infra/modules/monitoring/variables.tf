variable "project_id" {
  type = string
}

variable "env" {
  type = string
}

variable "alert_email" {
  description = "Email channel; receives every severity. Empty → no email channel."
  type        = string
  default     = ""
}

variable "pagerduty_service_key" {
  description = "PagerDuty Events API v2 integration key of the on-call service. Receives CRITICAL policies only. Empty → no PagerDuty channel. Pass as TF_VAR_pagerduty_service_key, never in tfvars."
  type        = string
  default     = ""
  sensitive   = true
}

variable "alert_webhook_url" {
  description = "Token-in-URL webhook (Better Stack-style) for CRITICAL policies. Empty → no webhook channel. Pass as TF_VAR_alert_webhook_url, never in tfvars."
  type        = string
  default     = ""
  sensitive   = true
}

variable "uptime_hosts" {
  description = "Service key → public hostname to probe at /healthz."
  type        = map(string)
  default     = {}
}

variable "log_alerts" {
  description = "Alert per log message substring: { key = { match, summary, severity, runbook, section? } }. runbook is a file name under docs/runbooks/; section an optional heading in it."
  type = map(object({
    match    = string
    summary  = string
    severity = string # CRITICAL | ERROR | WARNING
    runbook  = string
    section  = optional(string, "")
  }))
  default = {}

  validation {
    condition     = alltrue([for a in values(var.log_alerts) : contains(["CRITICAL", "ERROR", "WARNING"], a.severity)])
    error_message = "severity must be CRITICAL, ERROR or WARNING."
  }
  validation {
    condition     = alltrue([for a in values(var.log_alerts) : !can(regex("[\"\\\\]", a.match))])
    error_message = "match must not contain quotes or backslashes (it is embedded in a logging filter)."
  }
  validation {
    condition     = alltrue([for a in values(var.log_alerts) : can(regex("^[a-z0-9-]+\\.md$", a.runbook))])
    error_message = "runbook must be a file name under docs/runbooks/ (e.g. deploy.md)."
  }
}

variable "run_services" {
  description = "Cloud Run service keys that exist in this environment; SLO policies are created only for the ones they apply to (hooks, voice, api)."
  type        = list(string)
  default     = []
}

variable "subscriptions" {
  description = "Worker Pub/Sub subscription ids to watch for backlog (oldest unacked message age)."
  type        = list(string)
  default     = []
}

variable "dead_letter_subscriptions" {
  type    = list(string)
  default = []
}

variable "slo" {
  description = "SLO thresholds (SPEC §6.8 / ADR-0006): hooks ack p99 ms, voice tool p95 ms, 5xx ratio (0–1), Pub/Sub backlog age seconds."
  type = object({
    hooks_p99_ms        = optional(number, 800)
    voice_p95_ms        = optional(number, 700)
    error_ratio         = optional(number, 0.02)
    backlog_age_seconds = optional(number, 300)
  })
  default = {}

  validation {
    condition     = var.slo.error_ratio > 0 && var.slo.error_ratio < 1
    error_message = "slo.error_ratio is a fraction between 0 and 1 (0.02 = 2%)."
  }
}

variable "worker_error_threshold" {
  type    = number
  default = 20
}

variable "service_error_threshold" {
  type    = number
  default = 20
}
