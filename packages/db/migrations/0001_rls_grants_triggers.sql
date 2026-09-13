-- 0001 — RLS policies, grants, guard functions, triggers, views.
--
-- Hand-written on purpose: this is the migration that makes CLAUDE.md invariant 15 true, and a
-- reviewer should be able to read it as SQL. drizzle-kit owns 0000 (tables/indexes/checks);
-- this file owns everything about WHO may see and change WHAT.
--
-- Roles (docker/postgres/init, docs/runbooks/neon-bootstrap.md):
--   migrator  owner of every object; runs this file; never an application connection
--   naaradh_app      NOBYPASSRLS non-owner — every service that serves a merchant request
--   naaradh_service  BYPASSRLS, grant-limited — hooks + cross-tenant workers only (ADR-0004)

-- ---------------------------------------------------------------------------------------
-- 1. The tenant-context accessor. Every policy calls this instead of current_setting()
--    directly, so a missing/empty/malformed context RAISES rather than matching zero rows.
--    The silent form (current_setting(..., true) = '') is how a forgotten withTenant() turns
--    "no suppression found" into a call that should never have been placed.
-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS text
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  t text;
BEGIN
  t := current_setting('app.tenant_id', true);
  IF t IS NULL OR t = '' THEN
    RAISE EXCEPTION 'app.tenant_id is not set: wrap the query in withTenant()'
      USING ERRCODE = 'P0001', HINT = 'packages/db/src/tenant.ts';
  END IF;
  IF t !~ '^ten_[0-9A-HJKMNP-TV-Z]{26}$' THEN
    RAISE EXCEPTION 'app.tenant_id is malformed' USING ERRCODE = 'P0001';
  END IF;
  RETURN t;
END;
$$;
COMMENT ON FUNCTION app_tenant_id() IS 'RLS tenant context. Raises when unset — never returns empty.';
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 2. FORCE RLS: without this the table OWNER (the migrator) bypasses its own policies.
-- ---------------------------------------------------------------------------------------
ALTER TABLE tenants                    FORCE ROW LEVEL SECURITY;
ALTER TABLE users                      FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys                   FORCE ROW LEVEL SECURITY;
ALTER TABLE integrations               FORCE ROW LEVEL SECURITY;
ALTER TABLE use_cases                  FORCE ROW LEVEL SECURITY;
ALTER TABLE scripts                    FORCE ROW LEVEL SECURITY;
ALTER TABLE numbers                    FORCE ROW LEVEL SECURITY;
ALTER TABLE transfer_targets           FORCE ROW LEVEL SECURITY;
ALTER TABLE flags                      FORCE ROW LEVEL SECURITY;
ALTER TABLE contacts                   FORCE ROW LEVEL SECURITY;
ALTER TABLE consents                   FORCE ROW LEVEL SECURITY;
ALTER TABLE suppressions               FORCE ROW LEVEL SECURITY;
ALTER TABLE erasure_requests           FORCE ROW LEVEL SECURITY;
ALTER TABLE campaigns                  FORCE ROW LEVEL SECURITY;
ALTER TABLE call_intents               FORCE ROW LEVEL SECURITY;
ALTER TABLE call_attempts              FORCE ROW LEVEL SECURITY;
ALTER TABLE call_outcomes              FORCE ROW LEVEL SECURITY;
ALTER TABLE outcome_disputes           FORCE ROW LEVEL SECURITY;
ALTER TABLE complaints                 FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_ledger             FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log                  FORCE ROW LEVEL SECURITY;
ALTER TABLE merchant_webhooks          FORCE ROW LEVEL SECURITY;
ALTER TABLE merchant_webhook_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys           FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_events             FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 3. Policies. Plain tenant tables: one row-owner policy for everything.
-- ---------------------------------------------------------------------------------------
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON integrations
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON use_cases
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON scripts
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON transfer_targets
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON contacts
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON consents
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON erasure_requests
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON campaigns
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON call_intents
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON call_attempts
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON call_outcomes
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON outcome_disputes
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON complaints
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON billing_ledger
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON merchant_webhooks
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON merchant_webhook_deliveries
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- webhook_events is written by the service role (which bypasses RLS) before a tenant is
-- known; this policy governs any later tenant-scoped read (dashboard replay view).
CREATE POLICY tenant_isolation ON webhook_events
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- tenants: a tenant sees and edits only its own row. Creation is a service-role operation.
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());
--> statement-breakpoint

-- Tables where NULL tenant_id means "global": readable by every tenant, writable by none of
-- them (global rows come from the service role: DNC page, complaints, staff provisioning).
CREATE POLICY read_own_or_global ON numbers FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = app_tenant_id());
-- No INSERT/UPDATE/DELETE policy on numbers for the app role: provisioning is staff work and
-- last_used_at goes through touch_number() below.

CREATE POLICY read_own_or_global ON suppressions FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = app_tenant_id());
CREATE POLICY write_own ON suppressions FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY lift_own ON suppressions FOR UPDATE
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY read_own_or_global ON flags FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = app_tenant_id());
CREATE POLICY write_own ON flags FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY update_own ON flags FOR UPDATE
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 4. Grants. Explicit, so this migration is complete on its own (default privileges differ
--    between the docker bootstrap and Neon). The pattern:
--      mutable tenant tables     app: S/I/U   service: S/I/U
--      append-only tables        both: S/I only, UPDATE/DELETE explicitly revoked
--      staff/system tables       app: S       service: S/I/U(/D for expiry sweeps)
--    DELETE exists only where a sweep needs it. Business data is never deleted by a role;
--    erasure tombstones, retention nulls columns.
-- ---------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON
  users, api_keys, integrations, use_cases, scripts, transfer_targets, contacts,
  suppressions, erasure_requests, campaigns, call_intents, call_attempts, call_outcomes,
  outcome_disputes, complaints, merchant_webhooks, merchant_webhook_deliveries,
  idempotency_keys, flags, dnd_scrub_cache, number_type_cache
TO naaradh_app, naaradh_service;

-- tenants: merchants may edit their own operational settings; lifecycle, billing, routing and
-- residency columns are changed only by workers/staff via the service role.
GRANT SELECT ON tenants TO naaradh_app, naaradh_service;
GRANT UPDATE (
  name, legal_name, timezone, gstin, pan, dlt_pe_id,
  spend_cap_daily_paise, spend_cap_monthly_paise, retention_days,
  amd_mode_transactional, amd_mode_promotional,
  auto_cancel_enabled, address_write_enabled, shopify_sync_optout,
  settings, updated_at
) ON tenants TO naaradh_app;
GRANT INSERT, UPDATE ON tenants TO naaradh_service;

-- append-only
GRANT SELECT, INSERT ON consents, billing_ledger, audit_log TO naaradh_app, naaradh_service;
REVOKE UPDATE, DELETE, TRUNCATE ON consents, billing_ledger, audit_log FROM naaradh_app, naaradh_service;

-- staff / system. The bootstrap's default privileges hand every new table SELECT+INSERT, so
-- the INSERT is revoked here explicitly: a tenant trying to create a number must fail at
-- the grant layer ("permission denied"), not merely at the policy layer.
GRANT SELECT ON numbers, kill_switches, webhook_events TO naaradh_app;
REVOKE INSERT, UPDATE, DELETE ON numbers, kill_switches, webhook_events FROM naaradh_app;
GRANT SELECT, INSERT, UPDATE ON numbers, kill_switches, webhook_events TO naaradh_service;

-- expiry sweeps (service only)
GRANT DELETE ON idempotency_keys, dnd_scrub_cache, number_type_cache TO naaradh_service;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO naaradh_app, naaradh_service;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 5. SECURITY DEFINER helpers: the three lookups that legitimately run BEFORE a tenant
--    context exists, exposed as narrow functions instead of handing the request path the
--    service role. Each returns the minimum and searches only `public`.
-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_tenant_by_api_key(p_key_hash text)
RETURNS TABLE (
  tenant_id text, api_key_id text, kind api_key_kind, scopes text[],
  allowed_domains text[], ip_allowlist text[], daily_cap integer,
  tenant_status tenant_status, revoked_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT k.tenant_id, k.id, k.kind, k.scopes, k.allowed_domains, k.ip_allowlist, k.daily_cap,
         t.status, k.revoked_at
  FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
  WHERE k.key_hash = p_key_hash;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resolve_tenant_by_integration(p_kind integration_kind, p_external_id text)
RETURNS TABLE (tenant_id text, integration_id text, status integration_status, tenant_status tenant_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.tenant_id, i.id, i.status, t.status
  FROM integrations i JOIN tenants t ON t.id = i.tenant_id
  WHERE i.kind = p_kind AND i.external_id = p_external_id;
$$;
--> statement-breakpoint

-- The dispatcher (app role, tenant context) records use of a POOL number it cannot update
-- directly. Touches last_used_at only.
CREATE OR REPLACE FUNCTION touch_number(p_number_id text, p_used_at timestamptz)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE numbers SET last_used_at = GREATEST(COALESCE(last_used_at, p_used_at), p_used_at)
  WHERE id = p_number_id;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION resolve_tenant_by_api_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_tenant_by_integration(integration_kind, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION touch_number(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_tenant_id() TO naaradh_app, naaradh_service;
GRANT EXECUTE ON FUNCTION resolve_tenant_by_api_key(text) TO naaradh_app, naaradh_service;
GRANT EXECUTE ON FUNCTION resolve_tenant_by_integration(integration_kind, text) TO naaradh_app, naaradh_service;
GRANT EXECUTE ON FUNCTION touch_number(text, timestamptz) TO naaradh_app, naaradh_service;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 6. Triggers. Each one turns a rule from the spec into something the database refuses,
--    regardless of which role or which bug is asking.
-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenants','users','integrations','use_cases','numbers','transfer_targets','contacts',
    'erasure_requests','campaigns','call_intents','call_attempts','call_outcomes',
    'outcome_disputes','complaints','webhook_events','merchant_webhooks',
    'merchant_webhook_deliveries','flags'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                   t || '_set_updated_at', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Append-only, enforced below the grant layer too: even a superuser session gets refused
-- unless it deliberately disables the trigger — which is an audited act, not an accident.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: corrections are new rows (AGENTS.md §4)', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER consents_append_only       BEFORE UPDATE OR DELETE ON consents       FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER billing_ledger_append_only BEFORE UPDATE OR DELETE ON billing_ledger FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_append_only      BEFORE UPDATE OR DELETE ON audit_log      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- Invariant 4 / AGENTS §5.5: the dispatch envelope is never widened "to get a retry in", and
-- the 30-minute clock (event_ts) is never restarted.
CREATE OR REPLACE FUNCTION call_intents_envelope_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_ts <> OLD.event_ts THEN
    RAISE EXCEPTION 'call_intents.event_ts is immutable (invariant 4)' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.not_after > OLD.not_after THEN
    RAISE EXCEPTION 'call_intents.not_after may not be extended (invariant 4, E-01/E-02)' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.idempotency_key <> OLD.idempotency_key THEN
    RAISE EXCEPTION 'call_intents.idempotency_key is immutable (invariant 10)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER call_intents_envelope_guard BEFORE UPDATE ON call_intents FOR EACH ROW EXECUTE FUNCTION call_intents_envelope_guard();
--> statement-breakpoint

-- Invariant 11 / E-60, in the database: a row cannot claim to be billable unless the outcome
-- is one of the five, and once billed the outcome is frozen (disputes credit, they do not edit).
CREATE OR REPLACE FUNCTION call_outcomes_billable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billable AND NEW.outcome NOT IN ('confirmed','confirmed_with_changes','cancelled','rescheduled','booked') THEN
    RAISE EXCEPTION 'outcome % is not billable (invariant 11 / E-60)', NEW.outcome USING ERRCODE = 'P0001';
  END IF;
  IF NEW.billable AND NEW.superseded THEN
    RAISE EXCEPTION 'a superseded outcome is never billable (E-40)' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.billed_at IS NOT NULL THEN
    IF NEW.outcome <> OLD.outcome OR NEW.billable <> OLD.billable OR NEW.billed_at IS DISTINCT FROM OLD.billed_at THEN
      RAISE EXCEPTION 'a billed outcome is frozen; use outcome_disputes (E-62)' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER call_outcomes_billable_guard BEFORE INSERT OR UPDATE ON call_outcomes FOR EACH ROW EXECUTE FUNCTION call_outcomes_billable_guard();
--> statement-breakpoint

-- Universal rule 10: scripts are immutable per version. A draft may change freely; once
-- approved, only retirement is possible.
CREATE OR REPLACE FUNCTION scripts_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'retired' THEN
      RAISE EXCEPTION 'a draft is deleted, not retired' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  -- approved or retired: content columns are frozen
  IF NEW.body IS DISTINCT FROM OLD.body
     OR NEW.locale <> OLD.locale OR NEW.version <> OLD.version
     OR NEW.use_case_id <> OLD.use_case_id OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.dlt_template_id IS DISTINCT FROM OLD.dlt_template_id
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
     OR NEW.disclosure_validated_at IS DISTINCT FROM OLD.disclosure_validated_at THEN
    RAISE EXCEPTION 'script % v% is % and immutable; create a new version', OLD.id, OLD.version, OLD.status
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'approved' AND NEW.status NOT IN ('approved','retired') THEN
    RAISE EXCEPTION 'an approved script can only be retired' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'a retired script stays retired' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'retired' AND NEW.retired_at IS NULL THEN
    NEW.retired_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scripts_immutable BEFORE UPDATE ON scripts FOR EACH ROW EXECUTE FUNCTION scripts_immutable();
--> statement-breakpoint

-- Suppressions are current-state rows whose only permitted change is being lifted, once.
CREATE OR REPLACE FUNCTION suppressions_lift_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.phone_hash <> OLD.phone_hash
     OR NEW.purpose <> OLD.purpose OR NEW.reason <> OLD.reason
     OR NEW.external_ref IS DISTINCT FROM OLD.external_ref OR NEW.until IS DISTINCT FROM OLD.until
     OR NEW.source_attempt_id IS DISTINCT FROM OLD.source_attempt_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'suppressions may only be lifted; to change scope add a new row' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.lifted_at IS NOT NULL AND NEW.lifted_at IS DISTINCT FROM OLD.lifted_at THEN
    RAISE EXCEPTION 'a lifted suppression cannot be re-armed; add a new row' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.lifted_at IS NOT NULL AND (NEW.lifted_by IS NULL OR NEW.lifted_reason IS NULL) THEN
    RAISE EXCEPTION 'lifting a suppression requires lifted_by and lifted_reason (audit)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER suppressions_lift_only BEFORE UPDATE ON suppressions FOR EACH ROW EXECUTE FUNCTION suppressions_lift_only();
--> statement-breakpoint

-- Invariant 7: an attempt cannot record a human conversation without the disclosures having
-- been played. Guarded at the moment the attempt is marked ended-with-human.
CREATE OR REPLACE FUNCTION call_attempts_disclosure_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'ENDED' AND NEW.answered_by = 'human'
     AND (NEW.ai_disclosed_at IS NULL OR NEW.recording_disclosed_at IS NULL) THEN
    RAISE EXCEPTION 'attempt % ended with a human but disclosures were not logged (invariant 7)', NEW.id
      USING ERRCODE = 'P0001', HINT = 'If the engine cannot report this, the adapter must set it when the first utterance completes.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER call_attempts_disclosure_guard BEFORE INSERT OR UPDATE ON call_attempts FOR EACH ROW EXECUTE FUNCTION call_attempts_disclosure_guard();
--> statement-breakpoint

-- Transfers only ever go to a verified, active target (toll-fraud guard, E-30/Q-15).
CREATE OR REPLACE FUNCTION call_attempts_transfer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  IF NEW.transfer_target_id IS NOT NULL AND NEW.transfer_target_id IS DISTINCT FROM OLD.transfer_target_id THEN
    SELECT (tt.verified_at IS NOT NULL AND tt.active AND tt.tenant_id = NEW.tenant_id)
      INTO ok FROM transfer_targets tt WHERE tt.id = NEW.transfer_target_id;
    IF ok IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'transfer target % is not a verified, active target of this tenant', NEW.transfer_target_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER call_attempts_transfer_guard BEFORE INSERT OR UPDATE OF transfer_target_id ON call_attempts
  FOR EACH ROW EXECUTE FUNCTION call_attempts_transfer_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 7. Views. security_invoker = true is essential: a default view runs as its OWNER (the
--    migrator), which would quietly bypass RLS for whoever selects from it.
-- ---------------------------------------------------------------------------------------
CREATE VIEW active_consents WITH (security_invoker = true) AS
  SELECT g.*
  FROM consents g
  WHERE g.action = 'grant'
    AND (g.expires_at IS NULL OR g.expires_at > now())
    AND NOT EXISTS (SELECT 1 FROM consents r WHERE r.action = 'revoke' AND r.grant_id = g.id);
COMMENT ON VIEW active_consents IS 'Grants not revoked and not expired as of now(). The gate queries consents directly with an explicit instant; this is for the dashboard.';

CREATE VIEW active_suppressions WITH (security_invoker = true) AS
  SELECT s.*
  FROM suppressions s
  WHERE s.lifted_at IS NULL AND (s.until IS NULL OR s.until > now());

GRANT SELECT ON active_consents, active_suppressions TO naaradh_app, naaradh_service;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- 8. Documentation in the catalog, for anyone with only psql.
-- ---------------------------------------------------------------------------------------
COMMENT ON TABLE consents IS 'APPEND-ONLY consent ledger. Revocation = new row with action=revoke.';
COMMENT ON TABLE billing_ledger IS 'APPEND-ONLY. Credits are new rows.';
COMMENT ON TABLE audit_log IS 'APPEND-ONLY. Every state transition and every reveal of a masked number.';
COMMENT ON TABLE suppressions IS 'Current-state. tenant_id NULL = global (blocks every tenant). Only lifted_at/lifted_by/lifted_reason/notes may change.';
COMMENT ON TABLE numbers IS 'CLI pool. purpose_allowed is set by a human per Q-01; never defaulted in code.';
COMMENT ON TABLE contacts IS 'No plaintext phone column exists. phone_hash for lookups, phone_enc (RSA-OAEP) for dialling, phone_masked for display.';
COMMENT ON COLUMN call_intents.not_after IS 'Hard deadline. Trigger refuses any extension.';
COMMENT ON COLUMN call_attempts.ai_disclosed_at IS 'Invariant 7. Trigger refuses ENDED+human without it.';
COMMENT ON TABLE transfer_targets IS 'Only verified+active rows are transferable. The caller never chooses a number.';
