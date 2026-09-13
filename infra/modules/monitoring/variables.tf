variable "project_id" {
  type = string
}

variable "env" {
  type = string
}

variable "alert_email" {
  type    = string
  default = ""
}

variable "uptime_hosts" {
  description = "Service key → public hostname to probe at /healthz."
  type        = map(string)
  default     = {}
}

variable "log_alerts" {
  description = "Alert per log message substring: { key = { match, summary, severity, runbook } }."
  type = map(object({
    match    = string
    summary  = string
    severity = string # CRITICAL | ERROR | WARNING
    runbook  = string
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
}

variable "dead_letter_subscriptions" {
  type    = list(string)
  default = []
}

variable "worker_error_threshold" {
  type    = number
  default = 20
}

variable "service_error_threshold" {
  type    = number
  default = 20
}
