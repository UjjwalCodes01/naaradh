CREATE TYPE "public"."directory_kind" AS ENUM('shop', 'number');--> statement-breakpoint
CREATE TYPE "public"."stir_shaken_attestation" AS ENUM('A', 'B', 'C');--> statement-breakpoint
CREATE TABLE "dnc_registry_entries" (
	"phone_hash" text NOT NULL,
	"list" text NOT NULL,
	"version" text NOT NULL,
	CONSTRAINT "dnc_registry_entries_phone_hash_list_version_pk" PRIMARY KEY("phone_hash","list","version")
);
--> statement-breakpoint
CREATE TABLE "dnc_registry_lists" (
	"list" text PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"active_version" text,
	"loaded_at" timestamp with time zone,
	"row_count" integer,
	"area_codes" text[],
	"max_age_days" smallint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dnc_registry_lists_max_age" CHECK ("dnc_registry_lists"."max_age_days" between 1 and 31)
);
--> statement-breakpoint
CREATE TABLE "region_directory" (
	"kind" "directory_kind" NOT NULL,
	"key" text NOT NULL,
	"data_region" "data_region" NOT NULL,
	"source" "data_region" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "region_directory_kind_key_pk" PRIMARY KEY("kind","key"),
	CONSTRAINT "region_directory_key_format" CHECK (("region_directory"."kind" = 'shop' and "region_directory"."key" ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$') or ("region_directory"."kind" = 'number' and "region_directory"."key" ~ '^\+[1-9][0-9]{7,14}$'))
);
--> statement-breakpoint
ALTER TABLE "numbers" ADD COLUMN "attestation" "stir_shaken_attestation";--> statement-breakpoint
ALTER TABLE "numbers" ADD COLUMN "attestation_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "provider_customer_id" text;--> statement-breakpoint
ALTER TABLE "dnc_registry_entries" ADD CONSTRAINT "dnc_registry_entries_list_dnc_registry_lists_list_fk" FOREIGN KEY ("list") REFERENCES "public"."dnc_registry_lists"("list") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dnc_registry_entries_version_idx" ON "dnc_registry_entries" USING btree ("list","version");--> statement-breakpoint
-- 0014 (hand-written part) — Phase 6: US/EU calling and regional routing.
--
-- dnc_registry_lists / dnc_registry_entries (P6-CMP-1): the US National DNC Registry and the UK
-- TPS/CTPS, loaded from their licensed files by the dnc-load job (service role) and read by the
-- dispatcher's screening provider (app role). Global like dnd_scrub_cache: public registries,
-- the same for every tenant, holding hashes only (invariant 8). No RLS; no app writes.
-- The bootstrap's default privileges give every new table INSERT for the app role; a registry
-- the app could write to could be made to "screen" anyone, so revoke it explicitly.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON dnc_registry_lists, dnc_registry_entries FROM naaradh_app;
GRANT SELECT ON dnc_registry_lists, dnc_registry_entries TO naaradh_app, naaradh_service;
GRANT INSERT, UPDATE ON dnc_registry_lists TO naaradh_service;
GRANT INSERT, DELETE ON dnc_registry_entries TO naaradh_service;
--> statement-breakpoint
-- region_directory (ADR-0012 §4): shop domain / our own number → region. No personal data.
-- Written only by the directory-sync job (service role), derived from this deployment's own
-- tenants and pushed to its peers; read by the hooks edge to forward foreign traffic.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON region_directory FROM naaradh_app;
GRANT SELECT ON region_directory TO naaradh_app, naaradh_service;
GRANT INSERT, UPDATE, DELETE ON region_directory TO naaradh_service;
--> statement-breakpoint
CREATE TRIGGER dnc_registry_lists_set_updated_at BEFORE UPDATE ON dnc_registry_lists
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER region_directory_set_updated_at BEFORE UPDATE ON region_directory
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- numbers.attestation (P6-ENG-2) is set by staff in the console (service role, which already
-- has UPDATE on numbers). billing_subscriptions.provider_customer_id (P6-BILL-1) is covered by
-- the existing grants on that table.
COMMENT ON COLUMN numbers.attestation IS
  'STIR/SHAKEN attestation, recorded by a person from a test call or carrier report; the gate dials North America only from A';
