CREATE TYPE "public"."agent_action_status" AS ENUM('ok', 'refused', 'needs_verification', 'awaiting_confirmation', 'approved', 'ticketed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."caller_verification" AS ENUM('none', 'caller_id', 'knowledge');--> statement-breakpoint
CREATE TYPE "public"."knowledge_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."order_action_kind" AS ENUM('cancel');--> statement-breakpoint
CREATE TYPE "public"."order_action_status" AS ENUM('pending', 'executing', 'done', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."order_source" AS ENUM('shopify', 'woocommerce', 'api');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('cod', 'prepaid', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."profile_status" AS ENUM('draft', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."ticket_category" AS ENUM('order_status', 'cancellation', 'address_change', 'refund', 'return', 'delivery', 'product', 'complaint', 'callback', 'other');--> statement-breakpoint
CREATE TYPE "public"."ticket_source" AS ENUM('agent', 'api', 'dashboard');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'in_progress', 'resolved');--> statement-breakpoint
ALTER TYPE "public"."actor_type" ADD VALUE 'agent';--> statement-breakpoint
ALTER TYPE "public"."kill_switch_scope" ADD VALUE 'inbound';--> statement-breakpoint
ALTER TYPE "public"."outcome" ADD VALUE 'resolved';--> statement-breakpoint
ALTER TYPE "public"."outcome" ADD VALUE 'ticket_created';--> statement-breakpoint
ALTER TYPE "public"."outcome" ADD VALUE 'abandoned';--> statement-breakpoint
ALTER TYPE "public"."outcome" ADD VALUE 'spam';--> statement-breakpoint
CREATE TABLE "inbound_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "profile_status" DEFAULT 'draft' NOT NULL,
	"locale" text DEFAULT 'hi-IN' NOT NULL,
	"greeting" text NOT NULL,
	"persona" text,
	"business_hours" jsonb NOT NULL,
	"tools_enabled" text[] NOT NULL,
	"pinned_facts" text[] NOT NULL,
	"closed_message" text NOT NULL,
	"fallback_forward_enc" "bytea",
	"fallback_forward_kid" smallint,
	"fallback_forward_masked" text,
	"transfer_target_id" text,
	"max_duration_sec" smallint DEFAULT 600 NOT NULL,
	"max_concurrent" smallint DEFAULT 2 NOT NULL,
	"max_calls_per_caller_hour" smallint DEFAULT 6 NOT NULL,
	"monthly_minute_cap" integer,
	"agent_cancel_enabled" boolean DEFAULT false NOT NULL,
	"voice_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_profiles_id_format" CHECK ("id" ~ '^ipr_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "inbound_profiles_version_positive" CHECK ("inbound_profiles"."version" > 0),
	CONSTRAINT "inbound_profiles_concurrency" CHECK ("inbound_profiles"."max_concurrent" between 1 and 100),
	CONSTRAINT "inbound_profiles_caller_limit" CHECK ("inbound_profiles"."max_calls_per_caller_hour" between 1 and 60),
	CONSTRAINT "inbound_profiles_duration" CHECK ("inbound_profiles"."max_duration_sec" between 60 and 1800),
	CONSTRAINT "inbound_profiles_pinned_facts_max" CHECK (cardinality("inbound_profiles"."pinned_facts") <= 20),
	CONSTRAINT "inbound_profiles_fallback_pair" CHECK (("inbound_profiles"."fallback_forward_enc" is null) = ("inbound_profiles"."fallback_forward_kid" is null))
);
--> statement-breakpoint
ALTER TABLE "inbound_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"tool" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "agent_action_status" NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"order_id" text,
	"ticket_id" text,
	"parent_action_id" text,
	"confirm_token_hash" text,
	"token_expires_at" timestamp with time zone,
	"latency_ms" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_actions_id_format" CHECK ("id" ~ '^act_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "agent_actions_token_pair" CHECK (("agent_actions"."confirm_token_hash" is null) = ("agent_actions"."token_expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "agent_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_articles" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"locale" text DEFAULT 'en-IN' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "knowledge_status" DEFAULT 'draft' NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(body, '')), 'B')) STORED,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_articles_id_format" CHECK ("id" ~ '^kba_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "knowledge_articles_title_len" CHECK (char_length("knowledge_articles"."title") between 1 and 200),
	CONSTRAINT "knowledge_articles_body_len" CHECK (char_length("knowledge_articles"."body") between 1 and 8000)
);
--> statement-breakpoint
ALTER TABLE "knowledge_articles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "order_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_action_id" text NOT NULL,
	"order_id" text NOT NULL,
	"kind" "order_action_kind" NOT NULL,
	"status" "order_action_status" DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_actions_id_format" CHECK ("id" ~ '^oac_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "order_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source" "order_source" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"phone_hash" text,
	"pincode_hash" text,
	"payment_kind" "payment_kind" DEFAULT 'unknown' NOT NULL,
	"financial_status" text,
	"fulfillment_status" text,
	"cancelled_at" timestamp with time zone,
	"total_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"item_summary" text DEFAULT '' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"tracking" jsonb,
	"placed_at" timestamp with time zone NOT NULL,
	"source_updated_at" timestamp with time zone,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_id_format" CHECK ("id" ~ '^ord_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "orders_currency_iso" CHECK ("orders"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"attempt_id" text,
	"contact_id" text,
	"order_id" text,
	"category" "ticket_category" NOT NULL,
	"summary" text NOT NULL,
	"callback_requested" boolean DEFAULT false NOT NULL,
	"preferred_time" text,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"source" "ticket_source" NOT NULL,
	"priority" smallint DEFAULT 50 NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_id_format" CHECK ("id" ~ '^tkt_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "support_tickets_summary_len" CHECK (char_length("support_tickets"."summary") between 1 and 1000),
	CONSTRAINT "support_tickets_resolved_pair" CHECK (("support_tickets"."status" = 'resolved') = ("support_tickets"."resolved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "support_tickets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "numbers" ADD COLUMN "inbound_profile_id" text;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "inbound_profile_id" text;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "profile_version" integer;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "caller_withheld" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "caller_verification" "caller_verification" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "caller_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "verified_order_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "verify_failures" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "admission_trace" jsonb;--> statement-breakpoint
ALTER TABLE "inbound_profiles" ADD CONSTRAINT "inbound_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_profiles" ADD CONSTRAINT "inbound_profiles_transfer_target_id_transfer_targets_id_fk" FOREIGN KEY ("transfer_target_id") REFERENCES "public"."transfer_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_attempt_id_call_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."call_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_actions" ADD CONSTRAINT "order_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_actions" ADD CONSTRAINT "order_actions_agent_action_id_agent_actions_id_fk" FOREIGN KEY ("agent_action_id") REFERENCES "public"."agent_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_actions" ADD CONSTRAINT "order_actions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_attempt_id_call_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."call_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_profiles_tenant_idx" ON "inbound_profiles" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_actions_token_spent_once" ON "agent_actions" USING btree ("parent_action_id") WHERE "agent_actions"."parent_action_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_actions_attempt_idx" ON "agent_actions" USING btree ("attempt_id","at");--> statement-breakpoint
CREATE INDEX "agent_actions_tenant_idx" ON "agent_actions" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "knowledge_articles_search_idx" ON "knowledge_articles" USING gin ("search");--> statement-breakpoint
CREATE INDEX "knowledge_articles_tenant_idx" ON "knowledge_articles" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "order_actions_agent_action_uq" ON "order_actions" USING btree ("agent_action_id");--> statement-breakpoint
CREATE INDEX "order_actions_due_idx" ON "order_actions" USING btree ("status","next_attempt_at") WHERE "order_actions"."status" in ('pending','failed');--> statement-breakpoint
CREATE UNIQUE INDEX "orders_source_uq" ON "orders" USING btree ("tenant_id","source","external_id");--> statement-breakpoint
CREATE INDEX "orders_phone_idx" ON "orders" USING btree ("tenant_id","phone_hash","placed_at");--> statement-breakpoint
CREATE INDEX "orders_name_idx" ON "orders" USING btree ("tenant_id","name_key");--> statement-breakpoint
CREATE INDEX "support_tickets_tenant_idx" ON "support_tickets" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "support_tickets_attempt_idx" ON "support_tickets" USING btree ("attempt_id");--> statement-breakpoint
ALTER TABLE "numbers" ADD CONSTRAINT "numbers_inbound_profile_id_inbound_profiles_id_fk" FOREIGN KEY ("inbound_profile_id") REFERENCES "public"."inbound_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_inbound_profile_id_inbound_profiles_id_fk" FOREIGN KEY ("inbound_profile_id") REFERENCES "public"."inbound_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "numbers" ADD CONSTRAINT "numbers_inbound_needs_tenant" CHECK ("numbers"."inbound_profile_id" is null or "numbers"."tenant_id" is not null);--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_verify_failures" CHECK ("call_attempts"."verify_failures" between 0 and 10);--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_inbound_has_profile" CHECK ("call_attempts"."direction" = 'outbound' or "call_attempts"."inbound_profile_id" is not null);