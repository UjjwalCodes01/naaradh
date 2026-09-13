# Cloud Armor backend security policies (P2-INF-1), one per traffic profile, attached to the
# LB backend services (modules/lb). Rule order (lower priority number wins, first match ends):
#
#    100-199  allow-lists (e.g. voice engines' published ranges) — skip everything below
#    200      oversized bodies → 403 (header check; the apps enforce the real bodyLimit too)
#    1000     per-IP rate limit (ban or throttle)
#    2000+    OWASP preconfigured WAF rules (preview or enforce, per policy)
#    default  allow
#
# The apps keep their own per-IP / per-key limits (@fastify/rate-limit) as defence in depth;
# Armor stops floods before they cost a Cloud Run instance.

locals {
  # CRS 3.3 preconfigured rules at sensitivity 1 (lowest false-positive level).
  waf_rules = {
    sqli             = { priority = 2000, expr = "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})" }
    xss              = { priority = 2001, expr = "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})" }
    lfi              = { priority = 2002, expr = "evaluatePreconfiguredWaf('lfi-v33-stable', {'sensitivity': 1})" }
    rfi              = { priority = 2003, expr = "evaluatePreconfiguredWaf('rfi-v33-stable', {'sensitivity': 1})" }
    rce              = { priority = 2004, expr = "evaluatePreconfiguredWaf('rce-v33-stable', {'sensitivity': 1})" }
    scannerdetection = { priority = 2005, expr = "evaluatePreconfiguredWaf('scannerdetection-v33-stable', {'sensitivity': 1})" }
    protocolattack   = { priority = 2006, expr = "evaluatePreconfiguredWaf('protocolattack-v33-stable', {'sensitivity': 1})" }
    sessionfixation  = { priority = 2007, expr = "evaluatePreconfiguredWaf('sessionfixation-v33-stable', {'sensitivity': 1})" }
  }
}

resource "google_compute_security_policy" "policy" {
  for_each = var.policies

  project     = var.project_id
  name        = "naaradh-${each.key}"
  description = each.value.description
  type        = "CLOUD_ARMOR"

  advanced_options_config {
    # Parse JSON bodies so WAF signatures match values, not JSON punctuation (fewer false hits on
    # webhook and tool-call payloads).
    json_parsing = "STANDARD"
    # VERBOSE while any rule is in preview: the log shows which signature matched, needed to tune.
    log_level = each.value.waf_preview ? "VERBOSE" : "NORMAL"
  }

  # --- allow-lists -------------------------------------------------------------------------
  dynamic "rule" {
    for_each = length(each.value.allow_ranges) > 0 ? [1] : []
    content {
      action      = "allow"
      priority    = 100
      description = "Published vendor ranges: skip rate limit and WAF"
      match {
        versioned_expr = "SRC_IPS_V1"
        config {
          src_ip_ranges = each.value.allow_ranges
        }
      }
    }
  }

  # --- body size cap -----------------------------------------------------------------------
  dynamic "rule" {
    for_each = each.value.body_cap_regex == "" ? [] : [1]
    content {
      action      = "deny(403)"
      priority    = 200
      description = "Content-Length above the policy cap"
      match {
        expr {
          expression = "request.headers['content-length'].matches('${each.value.body_cap_regex}')"
        }
      }
    }
  }

  # --- rate limit --------------------------------------------------------------------------
  rule {
    action      = each.value.rate_limit.action == "ban" ? "rate_based_ban" : "throttle"
    priority    = 1000
    description = "Per-IP rate limit: ${each.value.rate_limit.count}/${each.value.rate_limit.interval_sec}s (${each.value.rate_limit.action})"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action   = "allow"
      exceed_action    = "deny(429)"
      enforce_on_key   = "IP"
      ban_duration_sec = each.value.rate_limit.action == "ban" ? each.value.rate_limit.ban_sec : null
      rate_limit_threshold {
        count        = each.value.rate_limit.count
        interval_sec = each.value.rate_limit.interval_sec
      }
    }
  }

  # --- OWASP preconfigured WAF -------------------------------------------------------------
  dynamic "rule" {
    for_each = local.waf_rules
    content {
      action      = "deny(403)"
      priority    = rule.value.priority
      description = "OWASP CRS 3.3 ${rule.key}${each.value.waf_preview ? " (preview: log only)" : ""}"
      preview     = each.value.waf_preview
      match {
        expr {
          expression = rule.value.expr
        }
      }
    }
  }

  # --- default -----------------------------------------------------------------------------
  rule {
    action      = "allow"
    priority    = 2147483647
    description = "Default allow"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}
