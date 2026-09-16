CREATE TYPE "public"."checkout_status" AS ENUM('open', 'scheduled', 'skipped', 'completed', 'converted', 'expired');--> statement-breakpoint
CREATE TYPE "public"."qa_review_status" AS ENUM('pending', 'done', 'skipped');--> statement-breakpoint
ALTER TYPE "public"."outcome" ADD VALUE 'will_complete';--> statement-breakpoint
ALTER TYPE "public"."outcome" ADD VALUE 'will_buy_later';--> statement-breakpoint
ALTER TYPE "public"."outcome" ADD VALUE 'not_interested';--> statement-breakpoint
ALTER TYPE "public"."outcome" ADD VALUE 'price_objection';--> statement-breakpoint
ALTER TYPE "public"."outcome" ADD VALUE 'qualified';--> statement-breakpoint
ALTER TYPE "public"."outcome" ADD VALUE 'feedback_given';--> statement-breakpoint
CREATE TABLE "attributions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"use_case" "use_case_kind" NOT NULL,
	"order_id" text NOT NULL,
	"intent_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"outcome_id" text,
	"matched_by" text NOT NULL,
	"value_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"window_hours" smallint NOT NULL,
	"call_ended_at" timestamp with time zone NOT NULL,
	"order_placed_at" timestamp with time zone NOT NULL,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attributions_id_format" CHECK ("id" ~ '^atr_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "attributions_matched_by" CHECK ("attributions"."matched_by" in ('checkout', 'phone')),
	CONSTRAINT "attributions_order_after_call" CHECK ("attributions"."order_placed_at" >= "attributions"."call_ended_at")
);
--> statement-breakpoint
ALTER TABLE "attributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "checkouts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"phone_hash" text,
	"contact_id" text,
	"recipient_region" text,
	"value_minor" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"item_summary" text DEFAULT '' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"consent_wording" text,
	"status" "checkout_status" DEFAULT 'open' NOT NULL,
	"skip_reason" text,
	"source_created_at" timestamp with time zone NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"order_id" text,
	"intent_id" text,
	"swept_at" timestamp with time zone,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkouts_id_format" CHECK ("id" ~ '^chk_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "checkouts_currency_iso" CHECK ("checkouts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "checkouts_value_nonneg" CHECK ("checkouts"."value_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "checkouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "qa_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"week" text NOT NULL,
	"status" "qa_review_status" DEFAULT 'pending' NOT NULL,
	"sampled_at" timestamp with time zone NOT NULL,
	"reviewer" text,
	"reviewed_at" timestamp with time zone,
	"scores" jsonb,
	"extraction_correct" boolean,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_reviews_id_format" CHECK ("id" ~ '^qar_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "qa_reviews_week_format" CHECK ("qa_reviews"."week" ~ '^[0-9]{4}-W[0-9]{2}$'),
	CONSTRAINT "qa_reviews_done_has_review" CHECK ("qa_reviews"."status" <> 'done' or ("qa_reviews"."reviewed_at" is not null and "qa_reviews"."reviewer" is not null and "qa_reviews"."scores" is not null))
);
--> statement-breakpoint
ALTER TABLE "qa_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "promotional_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "promotional_paused_reason" text;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "dlt_template_id" text;--> statement-breakpoint
ALTER TABLE "complaints" ADD COLUMN "purpose" "purpose";--> statement-breakpoint
ALTER TABLE "complaints" ADD COLUMN "use_case" "use_case_kind";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "checkout_token" text;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_intent_id_call_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."call_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_attempt_id_call_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."call_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_outcome_id_call_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."call_outcomes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_intent_id_call_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."call_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_reviews" ADD CONSTRAINT "qa_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_reviews" ADD CONSTRAINT "qa_reviews_attempt_id_call_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."call_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attributions_order_uq" ON "attributions" USING btree ("tenant_id","order_id","use_case");--> statement-breakpoint
CREATE INDEX "attributions_period_idx" ON "attributions" USING btree ("tenant_id","use_case","order_placed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "checkouts_source_uq" ON "checkouts" USING btree ("tenant_id","source","external_id");--> statement-breakpoint
CREATE INDEX "checkouts_sweep_idx" ON "checkouts" USING btree ("source_updated_at") WHERE "checkouts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "checkouts_phone_idx" ON "checkouts" USING btree ("tenant_id","phone_hash","source_created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_reviews_attempt_uq" ON "qa_reviews" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "qa_reviews_queue_idx" ON "qa_reviews" USING btree ("status","sampled_at");--> statement-breakpoint

-- 0012 (hand-written part) — promotional calling (ADR-0010).
ALTER TABLE checkouts    FORCE ROW LEVEL SECURITY;
ALTER TABLE attributions FORCE ROW LEVEL SECURITY;
-- qa_reviews: staff data. The app role has no grant at all (below); the tenant policy is there
-- so the table keeps the same isolation as every other tenant table if a grant is ever added.
ALTER TABLE qa_reviews   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON checkouts
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON attributions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON qa_reviews
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
-- Checkouts are written by the intents consumer under the tenant, swept by reconcile (service).
-- Attributions are written under the tenant and reversed by an UPDATE. No DELETE: erasure and
-- retention null the phone hash (E-119).
GRANT SELECT, INSERT, UPDATE ON checkouts, attributions TO naaradh_app, naaradh_service;
REVOKE DELETE, TRUNCATE ON checkouts, attributions FROM naaradh_app, naaradh_service;
REVOKE ALL ON qa_reviews FROM naaradh_app;
GRANT SELECT, INSERT, UPDATE ON qa_reviews TO naaradh_service;
--> statement-breakpoint
CREATE TRIGGER checkouts_set_updated_at BEFORE UPDATE ON checkouts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER qa_reviews_set_updated_at BEFORE UPDATE ON qa_reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- A/B (ADR-0010 §8): at most one approved script per (use case, locale, arm); arms are A or B.
ALTER TABLE scripts ADD CONSTRAINT scripts_ab_arm_values CHECK (ab_arm IS NULL OR ab_arm IN ('A', 'B'));
CREATE UNIQUE INDEX scripts_one_approved_per_arm ON scripts (tenant_id, use_case_id, locale, (coalesce(ab_arm, '-')))
  WHERE status = 'approved';
