CREATE TYPE "public"."appointment_status" AS ENUM('scheduled', 'confirmed', 'rescheduled', 'cancelled', 'completed', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."calendar_provider" AS ENUM('calcom', 'google', 'manual');--> statement-breakpoint
CREATE TYPE "public"."calendar_status" AS ENUM('active', 'disabled', 'error');--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"calendar_id" text,
	"contact_id" text,
	"phone_hash" text,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"service" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"timezone" text NOT NULL,
	"status" "appointment_status" DEFAULT 'scheduled' NOT NULL,
	"provider_ref" text,
	"intent_id" text,
	"booked_by_attempt_id" text,
	"reminder_swept_at" timestamp with time zone,
	"provider_cancelled_at" timestamp with time zone,
	"provider_error" text,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_id_format" CHECK ("id" ~ '^apt_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "appointments_ends_after_starts" CHECK ("appointments"."ends_at" is null or "appointments"."ends_at" > "appointments"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "calendars" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" "calendar_provider" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"credentials_secret_ref" text,
	"slot_minutes" smallint DEFAULT 30 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "calendar_status" DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendars_id_format" CHECK ("id" ~ '^cal_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "calendars_slot_minutes" CHECK ("calendars"."slot_minutes" between 5 and 480)
);
--> statement-breakpoint
ALTER TABLE "calendars" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_intent_id_call_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."call_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_booked_by_attempt_id_call_attempts_id_fk" FOREIGN KEY ("booked_by_attempt_id") REFERENCES "public"."call_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_source_uq" ON "appointments" USING btree ("tenant_id","source","external_id");--> statement-breakpoint
CREATE INDEX "appointments_reminder_idx" ON "appointments" USING btree ("starts_at") WHERE status in ('scheduled','rescheduled') and intent_id is null and erased_at is null;--> statement-breakpoint
CREATE INDEX "appointments_phone_idx" ON "appointments" USING btree ("tenant_id","phone_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_provider_uq" ON "calendars" USING btree ("tenant_id","provider","external_id");--> statement-breakpoint
-- 0013 (hand-written part) — appointments (ADR-0011). Same isolation as every tenant table.
ALTER TABLE calendars    FORCE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON calendars
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON appointments
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
-- Calendars are recorded by staff (a provider credential is involved, go-live 09); appointments
-- arrive over the API, from the provider, or from a call. No DELETE: erasure nulls the phone
-- link and stamps `erased_at`, keeping the time for the merchant's own diary.
GRANT SELECT, INSERT, UPDATE ON calendars, appointments TO naaradh_app, naaradh_service;
REVOKE DELETE, TRUNCATE ON calendars, appointments FROM naaradh_app, naaradh_service;
--> statement-breakpoint
CREATE TRIGGER calendars_set_updated_at BEFORE UPDATE ON calendars
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER appointments_set_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
