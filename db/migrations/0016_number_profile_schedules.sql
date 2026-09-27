CREATE TABLE "number_profile_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"number_id" text NOT NULL,
	"inbound_profile_id" text NOT NULL,
	"zone" text NOT NULL,
	"days" smallint[] NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"priority" smallint DEFAULT 100 NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_profile_schedules_id_format" CHECK ("id" ~ '^nps_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "number_profile_schedules_times" CHECK ("number_profile_schedules"."start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "number_profile_schedules"."end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "number_profile_schedules"."start_time" <> "number_profile_schedules"."end_time"),
	CONSTRAINT "number_profile_schedules_days" CHECK (cardinality("number_profile_schedules"."days") between 1 and 7 and "number_profile_schedules"."days" <@ array[1,2,3,4,5,6,7]::smallint[]),
	CONSTRAINT "number_profile_schedules_priority" CHECK ("number_profile_schedules"."priority" between 0 and 1000)
);
--> statement-breakpoint
ALTER TABLE "number_profile_schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "number_profile_schedules" ADD CONSTRAINT "number_profile_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_profile_schedules" ADD CONSTRAINT "number_profile_schedules_number_id_numbers_id_fk" FOREIGN KEY ("number_id") REFERENCES "public"."numbers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_profile_schedules" ADD CONSTRAINT "number_profile_schedules_inbound_profile_id_inbound_profiles_id_fk" FOREIGN KEY ("inbound_profile_id") REFERENCES "public"."inbound_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "number_profile_schedules_number_idx" ON "number_profile_schedules" USING btree ("number_id","priority") WHERE "number_profile_schedules"."removed_at" is null;--> statement-breakpoint
-- 0016 (hand-written part) — P7-INB-1: one number, different inbound profiles by time of day.
-- Same isolation as every tenant table.
ALTER TABLE number_profile_schedules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON number_profile_schedules
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
-- Foreign keys are checked without RLS, so a row could otherwise name another tenant's number or
-- profile. Both must belong to the schedule's own tenant: a cross-tenant link here would put one
-- merchant's callers through another merchant's agent — invariant 16 by the back door.
CREATE OR REPLACE FUNCTION number_profile_schedules_same_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE number_owner text; profile_owner text;
BEGIN
  SELECT n.tenant_id INTO number_owner FROM numbers n WHERE n.id = NEW.number_id;
  IF number_owner IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'number % is not a number of tenant %', NEW.number_id, NEW.tenant_id
      USING ERRCODE = 'P0001';
  END IF;
  SELECT p.tenant_id INTO profile_owner FROM inbound_profiles p WHERE p.id = NEW.inbound_profile_id;
  IF profile_owner IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'inbound profile % is not a profile of tenant %', NEW.inbound_profile_id, NEW.tenant_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER number_profile_schedules_same_tenant
  BEFORE INSERT OR UPDATE OF tenant_id, number_id, inbound_profile_id ON number_profile_schedules
  FOR EACH ROW EXECUTE FUNCTION number_profile_schedules_same_tenant();
--> statement-breakpoint
-- A replaced schedule is retired (removed_at), never deleted: like every table here, the roles
-- hold no DELETE, and the retired rows are the record of which profile answered when.
GRANT SELECT, INSERT, UPDATE ON number_profile_schedules TO naaradh_app, naaradh_service;
REVOKE DELETE, TRUNCATE ON number_profile_schedules FROM naaradh_app, naaradh_service;
--> statement-breakpoint
CREATE TRIGGER number_profile_schedules_set_updated_at BEFORE UPDATE ON number_profile_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
