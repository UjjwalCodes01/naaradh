CREATE TYPE "public"."actor_type" AS ENUM('user', 'api_key', 'worker', 'system', 'shopify', 'engine');--> statement-breakpoint
CREATE TYPE "public"."amd_mode" AS ENUM('hangup', 'leave_message', 'continue');--> statement-breakpoint
CREATE TYPE "public"."answered_by" AS ENUM('human', 'machine', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."api_key_kind" AS ENUM('secret', 'public');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('DISPATCHING', 'UNCERTAIN', 'DIALING', 'RINGING', 'IN_CONVERSATION', 'TRANSFERRING', 'ENDED', 'NO_ANSWER', 'BUSY', 'AMD_HANGUP', 'AMD_MESSAGE_LEFT', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."billing_kind" AS ENUM('platform_fee', 'outcome', 'minute', 'credit', 'refund');--> statement-breakpoint
CREATE TYPE "public"."billing_provider" AS ENUM('shopify', 'razorpay', 'stripe', 'manual');--> statement-breakpoint
CREATE TYPE "public"."billing_status" AS ENUM('none', 'active', 'frozen', 'capped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."call_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'running', 'paused', 'completed', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."complaint_source" AS ENUM('trai', 'merchant', 'self_service', 'vendor', 'internal');--> statement-breakpoint
CREATE TYPE "public"."complaint_status" AS ENUM('received', 'valid', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."consent_action" AS ENUM('grant', 'revoke');--> statement-breakpoint
CREATE TYPE "public"."consent_source" AS ENUM('checkout', 'checkout_written', 'form', 'form_written', 'api', 'import', 'verbal', 'dca', 'attestation');--> statement-breakpoint
CREATE TYPE "public"."data_region" AS ENUM('in', 'us', 'eu');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'delivered', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."dnd_result" AS ENUM('registered', 'not_registered', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."erasure_source" AS ENUM('api', 'dashboard', 'call', 'shopify_redact', 'email', 'dnc_page');--> statement-breakpoint
CREATE TYPE "public"."erasure_status" AS ENUM('requested', 'in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."extraction_method" AS ENUM('engine', 'llm', 'manual');--> statement-breakpoint
CREATE TYPE "public"."integration_kind" AS ENUM('shopify', 'woocommerce', 'api', 'zoho', 'hubspot', 'calcom', 'gcal', 'gokwik', 'shiprocket', 'razorpay_magic', 'cashfree');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('active', 'uninstalled', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."intent_source" AS ENUM('shopify', 'woocommerce', 'api', 'gokwik', 'shiprocket', 'razorpay_magic', 'cashfree', 'zoho', 'hubspot', 'calcom', 'gcal', 'reconcile', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."intent_status" AS ENUM('CREATED', 'SCHEDULED', 'GATED', 'DISPATCHING', 'IN_PROGRESS', 'RETRY_SCHEDULED', 'COMPLETED', 'EXHAUSTED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."kill_switch_scope" AS ENUM('global', 'engine', 'tenant', 'campaign');--> statement-breakpoint
CREATE TYPE "public"."number_series" AS ENUM('140', '1600', '10digit', 'intl');--> statement-breakpoint
CREATE TYPE "public"."number_status" AS ENUM('warming', 'active', 'retired', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."outcome" AS ENUM('confirmed', 'confirmed_with_changes', 'cancelled', 'rescheduled', 'booked', 'no_answer', 'busy', 'voicemail', 'no_response', 'inconclusive', 'failed', 'wrong_number', 'minor_answered', 'opt_out', 'recording_refused', 'transferred', 'transfer_failed', 'callback_requested', 'needs_merchant_action', 'convert_to_prepaid_requested', 'outcome_superseded');--> statement-breakpoint
CREATE TYPE "public"."phone_type" AS ENUM('mobile', 'landline', 'voip', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."purpose" AS ENUM('transactional', 'service', 'promotional');--> statement-breakpoint
CREATE TYPE "public"."purpose_scope" AS ENUM('transactional', 'service', 'promotional', 'all');--> statement-breakpoint
CREATE TYPE "public"."script_status" AS ENUM('draft', 'approved', 'retired');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('opt_out', 'complaint', 'dnd', 'invalid', 'manual', 'minor', 'wrong_number', 'recording_refused', 'self_service', 'erasure');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('pending_review', 'active', 'paused', 'suspended', 'uninstalled');--> statement-breakpoint
CREATE TYPE "public"."transfer_result" AS ENUM('completed', 'no_answer', 'busy', 'failed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."use_case_kind" AS ENUM('cod_confirm', 'abandoned_cart', 'appointment_confirm', 'appointment_book', 'lead_callback', 'delivery_reschedule', 'feedback', 'reactivation', 'inbound_support');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('viewer', 'operator', 'manager', 'owner');--> statement-breakpoint
CREATE TYPE "public"."webhook_event_status" AS ENUM('received', 'published', 'processed', 'failed', 'duplicate', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."webhook_source" AS ENUM('shopify', 'woocommerce', 'engine_bolna', 'engine_omnidim', 'engine_retell', 'engine_simulator', 'razorpay', 'stripe', 'gokwik', 'shiprocket', 'razorpay_magic', 'cashfree');--> statement-breakpoint
CREATE TYPE "public"."writeback_status" AS ENUM('pending', 'done', 'failed', 'skipped', 'needs_review');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "api_key_kind" NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" text[] NOT NULL,
	"allowed_domains" text[],
	"ip_allowlist" text[],
	"daily_cap" integer,
	"created_by_user_id" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_id_format" CHECK ("id" ~ '^key_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "flags" (
	"tenant_id" text,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"reason" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flags_tenant_key_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","key")
);
--> statement-breakpoint
ALTER TABLE "flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" "integration_kind" NOT NULL,
	"external_id" text NOT NULL,
	"credentials_secret_ref" text,
	"scopes" text[],
	"api_version" text,
	"status" "integration_status" DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uninstalled_at" timestamp with time zone,
	"purge_due_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_id_format" CHECK ("id" ~ '^itg_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "numbers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"e164" text NOT NULL,
	"region" text NOT NULL,
	"series" "number_series" NOT NULL,
	"provider" text NOT NULL,
	"engine" text NOT NULL,
	"purpose_allowed" "purpose"[] NOT NULL,
	"inbound_enabled" boolean DEFAULT false NOT NULL,
	"status" "number_status" DEFAULT 'warming' NOT NULL,
	"answer_rate_7d" numeric(5, 4),
	"last_used_at" timestamp with time zone,
	"provisioning_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "numbers_id_format" CHECK ("id" ~ '^num_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "numbers_e164_format" CHECK ("numbers"."e164" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
ALTER TABLE "numbers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scripts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"use_case_id" text NOT NULL,
	"version" integer NOT NULL,
	"locale" text NOT NULL,
	"body" jsonb NOT NULL,
	"dlt_template_id" text,
	"status" "script_status" DEFAULT 'draft' NOT NULL,
	"disclosure_validated_at" timestamp with time zone,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"ab_arm" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scripts_id_format" CHECK ("id" ~ '^scr_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "scripts_version_positive" CHECK ("scripts"."version" > 0),
	CONSTRAINT "scripts_approved_requires_validation" CHECK ("scripts"."status" <> 'approved' or ("scripts"."approved_at" is not null and "scripts"."disclosure_validated_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "scripts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"country" text NOT NULL,
	"data_region" "data_region" NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"gstin" text,
	"pan" text,
	"status" "tenant_status" DEFAULT 'pending_review' NOT NULL,
	"review_until" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"paused_reason" text,
	"uninstalled_at" timestamp with time zone,
	"dlt_pe_id" text,
	"dlt_linked_at" timestamp with time zone,
	"spend_cap_daily_paise" bigint,
	"spend_cap_monthly_paise" bigint,
	"max_concurrency" smallint DEFAULT 2 NOT NULL,
	"retention_days" smallint DEFAULT 90 NOT NULL,
	"engine_override" text,
	"multi_engine_ok" boolean DEFAULT false NOT NULL,
	"amd_mode_transactional" "amd_mode" DEFAULT 'continue' NOT NULL,
	"amd_mode_promotional" "amd_mode" DEFAULT 'hangup' NOT NULL,
	"auto_cancel_enabled" boolean DEFAULT false NOT NULL,
	"address_write_enabled" boolean DEFAULT false NOT NULL,
	"shopify_sync_optout" boolean DEFAULT false NOT NULL,
	"billing_provider" "billing_provider",
	"billing_status" "billing_status" DEFAULT 'none' NOT NULL,
	"billing_grace_until" timestamp with time zone,
	"plan_code" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_id_format" CHECK ("id" ~ '^ten_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "tenants_retention_range" CHECK ("tenants"."retention_days" between 30 and 365),
	CONSTRAINT "tenants_concurrency_range" CHECK ("tenants"."max_concurrency" between 1 and 100),
	CONSTRAINT "tenants_country_iso" CHECK ("tenants"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "tenants_currency_iso" CHECK ("tenants"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transfer_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"label" text NOT NULL,
	"phone_hash" text NOT NULL,
	"phone_enc" "bytea" NOT NULL,
	"phone_enc_kid" smallint NOT NULL,
	"phone_masked" text NOT NULL,
	"region" text NOT NULL,
	"verified_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"hours" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_targets_id_format" CHECK ("id" ~ '^trf_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "transfer_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "use_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" "use_case_kind" NOT NULL,
	"purpose" "purpose" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "use_cases_id_format" CHECK ("id" ~ '^usc_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "use_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" "citext" NOT NULL,
	"name" text,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_id_format" CHECK ("id" ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "consents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"phone_hash" text NOT NULL,
	"action" "consent_action" DEFAULT 'grant' NOT NULL,
	"grant_id" text,
	"purpose" "purpose_scope" NOT NULL,
	"source" "consent_source" NOT NULL,
	"recipient_region" text NOT NULL,
	"evidence_uri" text,
	"wording_version" text,
	"external_ref" text,
	"captured_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consents_id_format" CHECK ("id" ~ '^con_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "consents_revoke_has_grant" CHECK (("consents"."action" = 'revoke') = ("consents"."grant_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"phone_hash" text NOT NULL,
	"phone_enc" "bytea",
	"phone_enc_kid" smallint,
	"phone_masked" text NOT NULL,
	"region" text NOT NULL,
	"phone_type" "phone_type" DEFAULT 'unknown' NOT NULL,
	"phone_type_checked_at" timestamp with time zone,
	"name" text,
	"locale_hint" text,
	"timezone" text,
	"source" text,
	"skip" boolean DEFAULT false NOT NULL,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_id_format" CHECK ("id" ~ '^cnt_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "contacts_hash_format" CHECK ("contacts"."phone_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "contacts_enc_pair" CHECK (("contacts"."phone_enc" is null) = ("contacts"."phone_enc_kid" is null))
);
--> statement-breakpoint
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "dnd_scrub_cache" (
	"phone_hash" text PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"result" "dnd_result" NOT NULL,
	"provider" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erasure_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"phone_hash" text NOT NULL,
	"source" "erasure_source" NOT NULL,
	"external_ref" text,
	"status" "erasure_status" DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erasure_requests_id_format" CHECK ("id" ~ '^era_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "erasure_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "number_type_cache" (
	"phone_hash" text PRIMARY KEY NOT NULL,
	"phone_type" "phone_type" NOT NULL,
	"provider" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"phone_hash" text NOT NULL,
	"purpose" "purpose_scope" DEFAULT 'all' NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"external_ref" text,
	"until" timestamp with time zone,
	"source_attempt_id" text,
	"notes" text,
	"created_by" text,
	"lifted_at" timestamp with time zone,
	"lifted_by" text,
	"lifted_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppressions_id_format" CHECK ("id" ~ '^sup_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "suppressions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "call_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"intent_id" text,
	"contact_id" text NOT NULL,
	"phone_hash" text NOT NULL,
	"direction" "call_direction" DEFAULT 'outbound' NOT NULL,
	"purpose" "purpose" NOT NULL,
	"external_ref" text,
	"attempt_no" smallint NOT NULL,
	"engine" text NOT NULL,
	"engine_call_id" text,
	"engine_agent_id" text,
	"from_e164" text NOT NULL,
	"number_id" text,
	"script_id" text,
	"script_version" integer,
	"amd_mode" "amd_mode" NOT NULL,
	"max_duration_sec" smallint NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "attempt_status" DEFAULT 'DISPATCHING' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"answered_by" "answered_by",
	"end_reason" text,
	"duration_sec" integer,
	"billable_sec" integer,
	"human_speech_sec" integer,
	"ai_disclosed_at" timestamp with time zone,
	"recording_disclosed_at" timestamp with time zone,
	"detected_locale" text,
	"recording_uri" text,
	"transcript_uri" text,
	"recording_persisted_at" timestamp with time zone,
	"transfer_target_id" text,
	"transfer_result" "transfer_result",
	"cost_paise_engine" bigint,
	"cost_paise_telephony" bigint,
	"vendor_cost_minor" bigint,
	"vendor_cost_currency" text,
	"fx_rate" numeric(12, 6),
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_attempts_id_format" CHECK ("id" ~ '^att_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "call_attempts_attempt_no_positive" CHECK ("call_attempts"."attempt_no" > 0),
	CONSTRAINT "call_attempts_outbound_has_intent" CHECK ("call_attempts"."direction" = 'inbound' or "call_attempts"."intent_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "call_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "call_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"use_case_id" text NOT NULL,
	"use_case" "use_case_kind" NOT NULL,
	"purpose" "purpose" NOT NULL,
	"direction" "call_direction" DEFAULT 'outbound' NOT NULL,
	"contact_id" text NOT NULL,
	"phone_hash" text NOT NULL,
	"recipient_region" text NOT NULL,
	"source" "intent_source" NOT NULL,
	"external_ref" text NOT NULL,
	"external_refs" text[] NOT NULL,
	"campaign_id" text,
	"event_ts" timestamp with time zone NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"priority" smallint DEFAULT 50 NOT NULL,
	"status" "intent_status" DEFAULT 'CREATED' NOT NULL,
	"gated_reason" text,
	"gate_trace" jsonb,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"locale" text NOT NULL,
	"script_id" text,
	"attempts_count" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"idempotency_key" text NOT NULL,
	"value_paise" bigint,
	"currency" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_intents_id_format" CHECK ("id" ~ '^int_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "call_intents_envelope" CHECK ("call_intents"."not_before" <= "call_intents"."not_after"),
	CONSTRAINT "call_intents_refs_nonempty" CHECK (cardinality("call_intents"."external_refs") >= 1)
);
--> statement-breakpoint
ALTER TABLE "call_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "call_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"intent_id" text,
	"outcome" "outcome" NOT NULL,
	"confidence" numeric(3, 2) NOT NULL,
	"extracted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extraction_method" "extraction_method" NOT NULL,
	"billable" boolean NOT NULL,
	"billable_reason" text NOT NULL,
	"superseded" boolean DEFAULT false NOT NULL,
	"billed_at" timestamp with time zone,
	"billing_ledger_id" text,
	"writeback_status" "writeback_status" DEFAULT 'pending' NOT NULL,
	"writeback_error" text,
	"writeback_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_outcomes_id_format" CHECK ("id" ~ '^out_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "call_outcomes_confidence_range" CHECK ("call_outcomes"."confidence" between 0 and 1),
	CONSTRAINT "call_outcomes_superseded_not_billable" CHECK (not ("call_outcomes"."superseded" and "call_outcomes"."billable"))
);
--> statement-breakpoint
ALTER TABLE "call_outcomes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"use_case_id" text NOT NULL,
	"name" text NOT NULL,
	"source" text,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"dispatched" integer DEFAULT 0 NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"max_concurrency" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_id_format" CHECK ("id" ~ '^cmp_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outcome_disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"outcome_id" text NOT NULL,
	"opened_by_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"resolved_by" text,
	"resolution" text,
	"credit_ledger_id" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outcome_disputes_id_format" CHECK ("id" ~ '^dsp_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "outcome_disputes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip_hash" text,
	"request_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_id_format" CHECK ("id" ~ '^aud_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" "billing_kind" NOT NULL,
	"ref" text,
	"qty" integer DEFAULT 1 NOT NULL,
	"unit_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"period" text NOT NULL,
	"provider" "billing_provider" NOT NULL,
	"provider_ref" text,
	"provider_posted_at" timestamp with time zone,
	"invoiced_at" timestamp with time zone,
	"vendor_cost_minor" bigint,
	"vendor_cost_currency" text,
	"fx_rate" numeric(12, 6),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_ledger_id_format" CHECK ("id" ~ '^led_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "billing_ledger_total" CHECK ("billing_ledger"."total_minor" = "billing_ledger"."unit_minor" * "billing_ledger"."qty")
);
--> statement-breakpoint
ALTER TABLE "billing_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "complaints" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"phone_hash" text NOT NULL,
	"source" "complaint_source" NOT NULL,
	"status" "complaint_status" DEFAULT 'received' NOT NULL,
	"attempt_id" text,
	"external_ref" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "complaints_id_format" CHECK ("id" ~ '^cpl_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "complaints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" smallint NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kill_switches" (
	"scope" "kill_switch_scope" NOT NULL,
	"key" text NOT NULL,
	"active" boolean NOT NULL,
	"reason" text,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"webhook_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_status_code" smallint,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_webhook_deliveries_id_format" CHECK ("id" ~ '^dlv_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "merchant_webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "merchant_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"url" text NOT NULL,
	"secret_ref" text NOT NULL,
	"events" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_webhooks_id_format" CHECK ("id" ~ '^whk_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "merchant_webhooks_https" CHECK ("merchant_webhooks"."url" ~ '^https://')
);
--> statement-breakpoint
ALTER TABLE "merchant_webhooks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" "webhook_source" NOT NULL,
	"external_event_id" text NOT NULL,
	"topic" text NOT NULL,
	"tenant_id" text,
	"external_account" text,
	"status" "webhook_event_status" DEFAULT 'received' NOT NULL,
	"signature_valid" boolean NOT NULL,
	"payload" jsonb,
	"payload_sha256" text,
	"headers" jsonb,
	"pubsub_message_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_id_format" CHECK ("id" ~ '^evt_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "webhook_events_rejected_no_body" CHECK ("webhook_events"."status" <> 'rejected' or "webhook_events"."payload" is null)
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "numbers" ADD CONSTRAINT "numbers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_use_case_id_use_cases_id_fk" FOREIGN KEY ("use_case_id") REFERENCES "public"."use_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_targets" ADD CONSTRAINT "transfer_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "use_cases" ADD CONSTRAINT "use_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_intent_id_call_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."call_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_number_id_numbers_id_fk" FOREIGN KEY ("number_id") REFERENCES "public"."numbers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_transfer_target_id_transfer_targets_id_fk" FOREIGN KEY ("transfer_target_id") REFERENCES "public"."transfer_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_intents" ADD CONSTRAINT "call_intents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_intents" ADD CONSTRAINT "call_intents_use_case_id_use_cases_id_fk" FOREIGN KEY ("use_case_id") REFERENCES "public"."use_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_intents" ADD CONSTRAINT "call_intents_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_intents" ADD CONSTRAINT "call_intents_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_intents" ADD CONSTRAINT "call_intents_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_outcomes" ADD CONSTRAINT "call_outcomes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_outcomes" ADD CONSTRAINT "call_outcomes_attempt_id_call_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."call_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_outcomes" ADD CONSTRAINT "call_outcomes_intent_id_call_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."call_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_use_case_id_use_cases_id_fk" FOREIGN KEY ("use_case_id") REFERENCES "public"."use_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_disputes" ADD CONSTRAINT "outcome_disputes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_disputes" ADD CONSTRAINT "outcome_disputes_outcome_id_call_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."call_outcomes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger" ADD CONSTRAINT "billing_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_webhook_deliveries" ADD CONSTRAINT "merchant_webhook_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_webhook_deliveries" ADD CONSTRAINT "merchant_webhook_deliveries_webhook_id_merchant_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."merchant_webhooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_webhooks" ADD CONSTRAINT "merchant_webhooks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_kind_external_uq" ON "integrations" USING btree ("kind","external_id");--> statement-breakpoint
CREATE INDEX "integrations_tenant_idx" ON "integrations" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "numbers_e164_uq" ON "numbers" USING btree ("e164");--> statement-breakpoint
CREATE INDEX "numbers_pool_idx" ON "numbers" USING btree ("region","status","engine");--> statement-breakpoint
CREATE UNIQUE INDEX "scripts_tenant_usecase_locale_version_uq" ON "scripts" USING btree ("tenant_id","use_case_id","locale","version");--> statement-breakpoint
CREATE INDEX "scripts_lookup_idx" ON "scripts" USING btree ("tenant_id","use_case_id","locale","status");--> statement-breakpoint
CREATE INDEX "tenants_status_idx" ON "tenants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "transfer_targets_tenant_idx" ON "transfer_targets" USING btree ("tenant_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "use_cases_tenant_kind_uq" ON "use_cases" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email_uq" ON "users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "consents_lookup_idx" ON "consents" USING btree ("tenant_id","phone_hash","purpose","captured_at");--> statement-breakpoint
CREATE INDEX "consents_grant_idx" ON "consents" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_tenant_hash_uq" ON "contacts" USING btree ("tenant_id","phone_hash");--> statement-breakpoint
CREATE INDEX "dnd_scrub_expires_idx" ON "dnd_scrub_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "erasure_requests_status_idx" ON "erasure_requests" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "erasure_requests_hash_idx" ON "erasure_requests" USING btree ("phone_hash");--> statement-breakpoint
CREATE INDEX "number_type_expires_idx" ON "number_type_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "suppressions_lookup_idx" ON "suppressions" USING btree ("phone_hash","tenant_id","purpose");--> statement-breakpoint
CREATE INDEX "suppressions_active_idx" ON "suppressions" USING btree ("phone_hash") WHERE "suppressions"."lifted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "call_attempts_idempotency_uq" ON "call_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "call_attempts_engine_call_uq" ON "call_attempts" USING btree ("engine","engine_call_id") WHERE "call_attempts"."engine_call_id" is not null;--> statement-breakpoint
CREATE INDEX "call_attempts_intent_idx" ON "call_attempts" USING btree ("intent_id","attempt_no");--> statement-breakpoint
CREATE INDEX "call_attempts_tenant_idx" ON "call_attempts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "call_attempts_limits_idx" ON "call_attempts" USING btree ("phone_hash","purpose","external_ref","created_at");--> statement-breakpoint
CREATE INDEX "call_attempts_live_idx" ON "call_attempts" USING btree ("status","last_event_at") WHERE "call_attempts"."status" in ('DISPATCHING','UNCERTAIN','DIALING','RINGING','IN_CONVERSATION','TRANSFERRING');--> statement-breakpoint
CREATE UNIQUE INDEX "call_intents_idempotency_uq" ON "call_intents" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "call_intents_tenant_status_idx" ON "call_intents" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "call_intents_queue_idx" ON "call_intents" USING btree ("priority","next_attempt_at") WHERE "call_intents"."status" in ('SCHEDULED','RETRY_SCHEDULED');--> statement-breakpoint
CREATE INDEX "call_intents_claimed_idx" ON "call_intents" USING btree ("claimed_at") WHERE "call_intents"."status" = 'DISPATCHING';--> statement-breakpoint
CREATE INDEX "call_intents_phone_idx" ON "call_intents" USING btree ("phone_hash","purpose","created_at");--> statement-breakpoint
CREATE INDEX "call_intents_external_idx" ON "call_intents" USING btree ("tenant_id","external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "call_outcomes_attempt_uq" ON "call_outcomes" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "call_outcomes_tenant_idx" ON "call_outcomes" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "call_outcomes_billing_idx" ON "call_outcomes" USING btree ("tenant_id","billed_at") WHERE "call_outcomes"."billable" and "call_outcomes"."billed_at" is null;--> statement-breakpoint
CREATE INDEX "campaigns_tenant_idx" ON "campaigns" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "outcome_disputes_outcome_uq" ON "outcome_disputes" USING btree ("outcome_id");--> statement-breakpoint
CREATE INDEX "outcome_disputes_tenant_idx" ON "outcome_disputes" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_at_idx" ON "audit_log" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_ledger_ref_uq" ON "billing_ledger" USING btree ("tenant_id","kind","ref") WHERE "billing_ledger"."ref" is not null;--> statement-breakpoint
CREATE INDEX "billing_ledger_period_idx" ON "billing_ledger" USING btree ("tenant_id","period");--> statement-breakpoint
CREATE INDEX "complaints_window_idx" ON "complaints" USING btree ("tenant_id","received_at");--> statement-breakpoint
CREATE INDEX "complaints_global_window_idx" ON "complaints" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_tenant_key_uq" ON "idempotency_keys" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "kill_switches_scope_key_uq" ON "kill_switches" USING btree ("scope","key");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_webhook_deliveries_event_uq" ON "merchant_webhook_deliveries" USING btree ("webhook_id","event_id");--> statement-breakpoint
CREATE INDEX "merchant_webhook_deliveries_due_idx" ON "merchant_webhook_deliveries" USING btree ("status","next_attempt_at") WHERE "merchant_webhook_deliveries"."status" in ('pending','failed');--> statement-breakpoint
CREATE INDEX "merchant_webhook_deliveries_tenant_idx" ON "merchant_webhook_deliveries" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "merchant_webhooks_tenant_idx" ON "merchant_webhooks" USING btree ("tenant_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_dedupe_uq" ON "webhook_events" USING btree ("source","external_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_tenant_idx" ON "webhook_events" USING btree ("tenant_id","received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("status","received_at");