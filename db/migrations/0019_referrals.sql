CREATE TYPE "public"."referral_status" AS ENUM('claimed', 'qualified', 'rewarded', 'void');--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_id_format" CHECK ("id" ~ '^rfc_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "referral_codes_format" CHECK ("referral_codes"."code" ~ '^[A-HJ-KMNP-Z2-9]{8}$')
);
--> statement-breakpoint
ALTER TABLE "referral_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"referrer_tenant_id" text NOT NULL,
	"code" text NOT NULL,
	"referred_name" text NOT NULL,
	"status" "referral_status" DEFAULT 'claimed' NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"qualified_at" timestamp with time zone,
	"rewarded_at" timestamp with time zone,
	"credit_ledger_id" text,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referrals_id_format" CHECK ("id" ~ '^rfl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "referrals_not_self" CHECK ("referrals"."tenant_id" <> "referrals"."referrer_tenant_id")
);
--> statement-breakpoint
ALTER TABLE "referrals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_tenant_id_tenants_id_fk" FOREIGN KEY ("referrer_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_codes_tenant_uq" ON "referral_codes" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_codes_code_uq" ON "referral_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_referred_uq" ON "referrals" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer_tenant_id","status");--> statement-breakpoint
-- 0019 (hand-written part) — P7-GTM-1 referrals.
ALTER TABLE referral_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE referrals      FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON referral_codes
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- Both sides of a referral may read it: the merchant who was referred, and the one who referred.
-- Nobody writes it through the app role: claim_referral() inserts, the billing worker moves it on.
CREATE POLICY both_sides_read ON referrals FOR SELECT
  USING (tenant_id = app_tenant_id() OR referrer_tenant_id = app_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON referral_codes TO naaradh_app;
GRANT SELECT, INSERT, UPDATE ON referral_codes, referrals TO naaradh_service;
GRANT SELECT ON referrals TO naaradh_app;
REVOKE UPDATE, DELETE, TRUNCATE ON referral_codes FROM naaradh_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON referrals FROM naaradh_app;
REVOKE DELETE, TRUNCATE ON referral_codes, referrals FROM naaradh_service;
--> statement-breakpoint
CREATE TRIGGER referrals_set_updated_at BEFORE UPDATE ON referrals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- The only way a referral is created: the REFERRED merchant (the tenant in context) enters a code.
-- Refused, with a reason the dashboard shows, when:
--   unknown_code        no merchant has that code
--   self                it is your own code
--   already_referred    this account already named a referrer (once, ever)
--   too_late            the account is more than p_window_days old — a referral is how you joined
--   same_people         an owner of the referring account is also a user here (self-referral
--                       through a second account)
--   referrer_inactive   the referring account is suspended or uninstalled
-- SECURITY DEFINER because it must read the referrer by code across tenants; it reads nothing
-- back to the caller but the referrer's name, which the caller was given with the code anyway.
CREATE OR REPLACE FUNCTION claim_referral(
  p_id text, p_code text, p_now timestamptz, p_window_days integer
) RETURNS TABLE (outcome text, referrer_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me text := app_tenant_id();
  v_referrer text;
  v_referrer_name text;
  v_referrer_status tenant_status;
  v_my_name text;
  v_my_created timestamptz;
BEGIN
  SELECT c.tenant_id, t.name, t.status INTO v_referrer, v_referrer_name, v_referrer_status
  FROM referral_codes c JOIN tenants t ON t.id = c.tenant_id
  WHERE c.code = upper(p_code);
  IF v_referrer IS NULL THEN RETURN QUERY SELECT 'unknown_code', NULL::text; RETURN; END IF;
  IF v_referrer = v_me THEN RETURN QUERY SELECT 'self', NULL::text; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM referrals r WHERE r.tenant_id = v_me) THEN
    RETURN QUERY SELECT 'already_referred', NULL::text; RETURN;
  END IF;
  SELECT t.name, t.created_at INTO v_my_name, v_my_created FROM tenants t WHERE t.id = v_me;
  IF v_my_created < p_now - make_interval(days => p_window_days) THEN
    RETURN QUERY SELECT 'too_late', NULL::text; RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM users mine JOIN users theirs ON theirs.email = mine.email
    WHERE mine.tenant_id = v_me AND theirs.tenant_id = v_referrer AND theirs.role = 'owner'
  ) THEN
    RETURN QUERY SELECT 'same_people', NULL::text; RETURN;
  END IF;
  IF v_referrer_status IN ('suspended', 'uninstalled') THEN
    RETURN QUERY SELECT 'referrer_inactive', NULL::text; RETURN;
  END IF;
  INSERT INTO referrals (id, tenant_id, referrer_tenant_id, code, referred_name, status, claimed_at)
  VALUES (p_id, v_me, v_referrer, upper(p_code), v_my_name, 'claimed', p_now);
  RETURN QUERY SELECT 'claimed', v_referrer_name;
END;
$$;
REVOKE ALL ON FUNCTION claim_referral(text, text, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_referral(text, text, timestamptz, integer) TO naaradh_app;
