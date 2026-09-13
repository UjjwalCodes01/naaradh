variable "project_id" {
  type = string
}

variable "policies" {
  description = "Security policies by key (api, hooks, voice, standard, console)."
  type = map(object({
    description = string
    rate_limit = object({
      action       = string # "ban" | "throttle"
      count        = number
      interval_sec = number
      ban_sec      = optional(number, 600)
    })
    waf_preview    = bool
    body_cap_regex = optional(string, "")       # RE2 on the Content-Length header; "" = no rule
    allow_ranges   = optional(list(string), []) # CIDRs that bypass rate limit + WAF
  }))

  validation {
    condition     = alltrue([for p in values(var.policies) : contains(["ban", "throttle"], p.rate_limit.action)])
    error_message = "rate_limit.action must be ban or throttle."
  }
  validation {
    condition     = alltrue([for p in values(var.policies) : length(p.allow_ranges) <= 10])
    error_message = "A SRC_IPS_V1 match takes at most 10 ranges; split into more rules if needed."
  }
}
