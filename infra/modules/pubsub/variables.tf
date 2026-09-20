variable "project_id" {
  type = string
}

variable "project_number" {
  type = string
}

variable "region" {
  description = "Only region messages may be persisted in (data residency)."
  type        = string
}

variable "prefix" {
  description = "PUBSUB_TOPIC_PREFIX used by the apps."
  type        = string
  default     = "naaradh"
}

variable "topics" {
  description = "Topic suffixes (hooks/src/pubsub.ts TopicName)."
  type        = list(string)
}

variable "subscriptions" {
  description = "One per consuming worker role: { topic, worker, member }."
  type = list(object({
    topic  = string
    worker = string
    member = string
  }))
}

variable "publishers" {
  description = "Members allowed to publish to every topic, keyed by a static label."
  type        = map(string)
  default     = {}
}
