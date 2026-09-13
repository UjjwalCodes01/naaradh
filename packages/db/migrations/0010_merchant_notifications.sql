CREATE TABLE "merchant_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"event_id" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"recipients" smallint,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_notifications_id_format" CHECK ("id" ~ '^ntf_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "merchant_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "merchant_notifications" ADD CONSTRAINT "merchant_notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_notifications_event_uq" ON "merchant_notifications" USING btree ("tenant_id","kind","event_id");--> statement-breakpoint
CREATE INDEX "merchant_notifications_due_idx" ON "merchant_notifications" USING btree ("next_attempt_at") WHERE "merchant_notifications"."status" in ('pending','failed');--> statement-breakpoint

-- 0010 (hand-written part) — merchant email notifications (P2-WEB-4).
ALTER TABLE merchant_notifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON merchant_notifications
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
-- The app role queues alerts inside its own transactions (api, voice, workers under
-- withTenant) and reads them for the dashboard; only the notifications worker (service)
-- updates delivery state.
GRANT SELECT, INSERT ON merchant_notifications TO naaradh_app;
REVOKE UPDATE, DELETE, TRUNCATE ON merchant_notifications FROM naaradh_app;
GRANT SELECT, INSERT, UPDATE ON merchant_notifications TO naaradh_service;
--> statement-breakpoint
CREATE TRIGGER merchant_notifications_set_updated_at BEFORE UPDATE ON merchant_notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
