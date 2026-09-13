CREATE TYPE "public"."billing_posting_kind" AS ENUM('usage_record', 'addon');--> statement-breakpoint
CREATE TYPE "public"."billing_posting_status" AS ENUM('pending', 'posted', 'capped', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."billing_subscription_status" AS ENUM('pending', 'active', 'frozen', 'cancelled', 'declined', 'expired');--> statement-breakpoint
CREATE TABLE "billing_postings" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" "billing_provider" NOT NULL,
	"kind" "billing_posting_kind" NOT NULL,
	"subscription_id" text,
	"period" text NOT NULL,
	"ledger_ids" text[] NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"description" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "billing_posting_status" DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"provider_ref" text,
	"last_error" text,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_postings_id_format" CHECK ("id" ~ '^bps_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "billing_postings_nonempty" CHECK (cardinality("billing_postings"."ledger_ids") >= 1),
	CONSTRAINT "billing_postings_amount" CHECK ("billing_postings"."amount_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "billing_postings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" "billing_provider" NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"provider_line_item_id" text,
	"plan_code" text,
	"inbound_plan_code" text,
	"status" "billing_subscription_status" DEFAULT 'pending' NOT NULL,
	"provider_status" text,
	"currency" text NOT NULL,
	"recurring_minor" bigint NOT NULL,
	"capped_amount_minor" bigint,
	"current_period_end" timestamp with time zone,
	"test" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_id_format" CHECK ("id" ~ '^bsb_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "billing_subscriptions_currency_iso" CHECK ("billing_subscriptions"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "inbound_plan_code" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "billing_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_postings" ADD CONSTRAINT "billing_postings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_postings" ADD CONSTRAINT "billing_postings_subscription_id_billing_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."billing_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_postings_idempotency_uq" ON "billing_postings" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "billing_postings_due_idx" ON "billing_postings" USING btree ("next_attempt_at") WHERE "billing_postings"."status" in ('pending','failed');--> statement-breakpoint
CREATE INDEX "billing_postings_ledger_idx" ON "billing_postings" USING gin ("ledger_ids");--> statement-breakpoint
CREATE INDEX "billing_postings_tenant_idx" ON "billing_postings" USING btree ("tenant_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_provider_uq" ON "billing_subscriptions" USING btree ("provider","provider_subscription_id");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_tenant_idx" ON "billing_subscriptions" USING btree ("tenant_id","created_at");
--> statement-breakpoint

-- 0008 (hand-written part) — billing (ADR-0008).
ALTER TABLE billing_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_postings      FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON billing_subscriptions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON billing_postings
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
-- The app role creates a PENDING subscription in the merchant's own context (the Shopify app /
-- API billing route) and reads postings for the dashboard. Status changes, postings and the
-- tenant's billing_status are written by the billing worker on the service role.
GRANT SELECT, INSERT ON billing_subscriptions TO naaradh_app;
GRANT SELECT ON billing_postings TO naaradh_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON billing_postings FROM naaradh_app;
REVOKE UPDATE, DELETE, TRUNCATE ON billing_subscriptions FROM naaradh_app;
GRANT SELECT, INSERT, UPDATE ON billing_subscriptions, billing_postings TO naaradh_service;
REVOKE DELETE, TRUNCATE ON billing_subscriptions, billing_postings FROM naaradh_service;
--> statement-breakpoint
CREATE TRIGGER billing_subscriptions_set_updated_at BEFORE UPDATE ON billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER billing_postings_set_updated_at BEFORE UPDATE ON billing_postings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
