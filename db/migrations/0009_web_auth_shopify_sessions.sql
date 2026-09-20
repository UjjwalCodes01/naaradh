CREATE TABLE "login_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_tokens_id_format" CHECK ("id" ~ '^ltk_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "login_tokens_hash_format" CHECK ("login_tokens"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "login_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shopify_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"shop" text NOT NULL,
	"state" text DEFAULT '' NOT NULL,
	"is_online" boolean DEFAULT false NOT NULL,
	"scope" text,
	"expires_at" timestamp with time zone,
	"secret_ciphertext" "bytea" NOT NULL,
	"secret_iv" "bytea" NOT NULL,
	"secret_tag" "bytea" NOT NULL,
	"secret_kid" smallint DEFAULT 1 NOT NULL,
	"online_access_info" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_sessions_shop_format" CHECK ("shopify_sessions"."shop" ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$')
);
--> statement-breakpoint
ALTER TABLE "shopify_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_sessions_id_format" CHECK ("id" ~ '^wss_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "web_sessions_hash_format" CHECK ("web_sessions"."session_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "web_sessions_user_agent_len" CHECK ("web_sessions"."user_agent" is null or char_length("web_sessions"."user_agent") <= 200)
);
--> statement-breakpoint
ALTER TABLE "web_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "login_tokens" ADD CONSTRAINT "login_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_tokens" ADD CONSTRAINT "login_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "login_tokens_hash_uq" ON "login_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "login_tokens_user_idx" ON "login_tokens" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "shopify_sessions_shop_idx" ON "shopify_sessions" USING btree ("shop");--> statement-breakpoint
CREATE UNIQUE INDEX "web_sessions_hash_uq" ON "web_sessions" USING btree ("session_hash");--> statement-breakpoint
CREATE INDEX "web_sessions_user_idx" ON "web_sessions" USING btree ("user_id","created_at");--> statement-breakpoint

-- 0009 (hand-written part) — merchant dashboard sign-in and Shopify app sessions (ADR-0009).
--
-- Neither the dashboard nor the Shopify app holds the service role (packages/db/src/service.ts:
-- BYPASSRLS never serves a merchant request). The steps that must run before a tenant is known —
-- looking up who an email belongs to, spending a login token, resolving a session cookie,
-- storing a Shopify session, provisioning a store on install — are narrow SECURITY DEFINER
-- functions, the same pattern as resolve_tenant_by_api_key() and submit_dnc_request().
ALTER TABLE login_tokens     FORCE ROW LEVEL SECURITY;
ALTER TABLE web_sessions     FORCE ROW LEVEL SECURITY;
ALTER TABLE shopify_sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON login_tokens
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON web_sessions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- shopify_sessions: RLS forced and NO policy — the app role cannot see a row even if a grant
-- slipped in. The definer functions below and the service role (workers) are the only readers.
--> statement-breakpoint

-- Grants. Default privileges hand new tables SELECT+INSERT to both roles; take back what the
-- app role must not have. Tokens are never read by the app role directly; sessions are listed
-- and revoked within the tenant ("sign out everywhere"), nothing else.
REVOKE ALL ON login_tokens, shopify_sessions FROM naaradh_app;
REVOKE ALL ON web_sessions FROM naaradh_app;
GRANT SELECT ON web_sessions TO naaradh_app;
GRANT UPDATE (revoked_at) ON web_sessions TO naaradh_app;
-- Expiry sweeps (retention worker) and the workers' token resolver.
GRANT SELECT, INSERT, UPDATE, DELETE ON login_tokens, web_sessions TO naaradh_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON shopify_sessions TO naaradh_service;
--> statement-breakpoint
CREATE TRIGGER shopify_sessions_set_updated_at BEFORE UPDATE ON shopify_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Dashboard sign-in
-- ---------------------------------------------------------------------------------------

-- Which accounts an email can sign in to. One email may belong to several merchants (the
-- users table is unique per (tenant, email)). The caller emails one link per account and
-- ALWAYS answers the browser the same way, so this never tells a stranger who is a customer.
CREATE OR REPLACE FUNCTION web_login_candidates(p_email citext)
RETURNS TABLE (user_id text, tenant_id text, tenant_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.tenant_id, t.name
  FROM users u JOIN tenants t ON t.id = u.tenant_id
  WHERE u.email = p_email AND u.disabled_at IS NULL AND t.status <> 'uninstalled'
  ORDER BY t.name, u.id
  LIMIT 10;
$$;
--> statement-breakpoint

-- Store a login token hash for one user. At most 5 live tokens per user: a flood of requests
-- for one address cannot fill the table (the API also rate-limits per email and per IP).
CREATE OR REPLACE FUNCTION create_login_token(
  p_id text, p_user_id text, p_token_hash text, p_expires_at timestamptz, p_ip_hash text, p_now timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant text;
BEGIN
  SELECT u.tenant_id INTO v_tenant FROM users u WHERE u.id = p_user_id AND u.disabled_at IS NULL;
  IF v_tenant IS NULL THEN RETURN false; END IF;
  IF (SELECT count(*) FROM login_tokens l
      WHERE l.user_id = p_user_id AND l.used_at IS NULL AND l.expires_at > p_now) >= 5 THEN
    RETURN false;
  END IF;
  INSERT INTO login_tokens (id, tenant_id, user_id, token_hash, expires_at, ip_hash)
  VALUES (p_id, v_tenant, p_user_id, p_token_hash, p_expires_at, p_ip_hash);
  RETURN true;
END;
$$;
--> statement-breakpoint

-- Spend a login token exactly once and open a session. The UPDATE ... WHERE used_at IS NULL
-- is the single-use guarantee under concurrency: two clicks race, one row comes back.
CREATE OR REPLACE FUNCTION consume_login_token(
  p_token_hash text, p_session_id text, p_session_hash text, p_session_expires_at timestamptz,
  p_user_agent text, p_ip_hash text, p_audit_id text, p_now timestamptz
) RETURNS TABLE (session_id text, user_id text, tenant_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user text; v_tenant text;
BEGIN
  UPDATE login_tokens l SET used_at = p_now
  WHERE l.token_hash = p_token_hash AND l.used_at IS NULL AND l.expires_at > p_now
  RETURNING l.user_id, l.tenant_id INTO v_user, v_tenant;
  IF v_user IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = v_user AND u.disabled_at IS NULL) THEN RETURN; END IF;
  INSERT INTO web_sessions (id, tenant_id, user_id, session_hash, expires_at, last_seen_at, user_agent, ip_hash)
  VALUES (p_session_id, v_tenant, v_user, p_session_hash, p_session_expires_at, p_now,
          left(p_user_agent, 200), p_ip_hash);
  UPDATE users SET last_login_at = p_now WHERE id = v_user;
  INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, action, target_type, target_id, ip_hash, at)
  VALUES (p_audit_id, v_tenant, 'user', v_user, 'user.signed_in', 'web_session', p_session_id, p_ip_hash, p_now);
  RETURN QUERY SELECT p_session_id, v_user, v_tenant;
END;
$$;
--> statement-breakpoint

-- Resolve a session cookie: live (not revoked, inside its absolute lifetime and the idle
-- window), user enabled. Touches last_seen_at at most every 5 minutes to keep writes rare.
CREATE OR REPLACE FUNCTION resolve_web_session(p_session_hash text, p_now timestamptz, p_idle_seconds integer)
RETURNS TABLE (
  session_id text, user_id text, tenant_id text, role user_role, email citext, name text,
  tenant_name text, tenant_status tenant_status, expires_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE web_sessions s SET last_seen_at = p_now
  WHERE s.session_hash = p_session_hash AND s.revoked_at IS NULL AND s.expires_at > p_now
    AND s.last_seen_at > p_now - make_interval(secs => p_idle_seconds)
    AND s.last_seen_at < p_now - interval '5 minutes';
  RETURN QUERY
  SELECT s.id, u.id, u.tenant_id, u.role, u.email, u.name, t.name, t.status, s.expires_at
  FROM web_sessions s
  JOIN users u ON u.id = s.user_id
  JOIN tenants t ON t.id = s.tenant_id
  WHERE s.session_hash = p_session_hash AND s.revoked_at IS NULL AND s.expires_at > p_now
    AND s.last_seen_at > p_now - make_interval(secs => p_idle_seconds)
    AND u.disabled_at IS NULL;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Shopify app sessions and install provisioning (ADR-0007, ADR-0009)
-- ---------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION shopify_session_store(
  p_id text, p_shop text, p_state text, p_is_online boolean, p_scope text, p_expires_at timestamptz,
  p_ciphertext bytea, p_iv bytea, p_tag bytea, p_kid smallint, p_online_access_info jsonb
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO shopify_sessions (id, shop, state, is_online, scope, expires_at,
    secret_ciphertext, secret_iv, secret_tag, secret_kid, online_access_info)
  VALUES (p_id, p_shop, p_state, p_is_online, p_scope, p_expires_at, p_ciphertext, p_iv, p_tag, p_kid, p_online_access_info)
  ON CONFLICT (id) DO UPDATE SET
    shop = EXCLUDED.shop, state = EXCLUDED.state, is_online = EXCLUDED.is_online,
    scope = EXCLUDED.scope, expires_at = EXCLUDED.expires_at,
    secret_ciphertext = EXCLUDED.secret_ciphertext, secret_iv = EXCLUDED.secret_iv,
    secret_tag = EXCLUDED.secret_tag, secret_kid = EXCLUDED.secret_kid,
    online_access_info = EXCLUDED.online_access_info;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION shopify_session_load(p_id text)
RETURNS TABLE (
  id text, shop text, state text, is_online boolean, scope text, expires_at timestamptz,
  secret_ciphertext bytea, secret_iv bytea, secret_tag bytea, secret_kid smallint, online_access_info jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.shop, s.state, s.is_online, s.scope, s.expires_at,
         s.secret_ciphertext, s.secret_iv, s.secret_tag, s.secret_kid, s.online_access_info
  FROM shopify_sessions s WHERE s.id = p_id;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION shopify_sessions_for_shop(p_shop text)
RETURNS TABLE (
  id text, shop text, state text, is_online boolean, scope text, expires_at timestamptz,
  secret_ciphertext bytea, secret_iv bytea, secret_tag bytea, secret_kid smallint, online_access_info jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.shop, s.state, s.is_online, s.scope, s.expires_at,
         s.secret_ciphertext, s.secret_iv, s.secret_tag, s.secret_kid, s.online_access_info
  FROM shopify_sessions s WHERE s.shop = p_shop ORDER BY s.id;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION shopify_session_delete(p_ids text[])
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH d AS (DELETE FROM shopify_sessions s WHERE s.id = ANY(p_ids) RETURNING 1)
  SELECT count(*)::int FROM d;
$$;
--> statement-breakpoint

-- A store opened the app with a fresh offline token: create its tenant (first install) or bring
-- the existing one back (reinstall after app/uninstalled, E-48). Serialised per shop by an
-- advisory lock so two concurrent first loads cannot create two tenants.
--   * new tenants start `pending_review` for 7 days (E-73: promotional blocked, transactional OK)
--   * a reinstall lifts ONLY the uninstall pause; a complaint/billing/staff pause stays
--   * integrations.credentials_secret_ref = 'shopify-session:offline_<shop>' (ADR-0007)
CREATE OR REPLACE FUNCTION provision_shopify_install(
  p_shop text, p_tenant_id text, p_integration_id text, p_user_id text, p_audit_id text,
  p_name text, p_country text, p_data_region data_region, p_timezone text, p_currency text,
  p_owner_email citext, p_scopes text[], p_api_version text, p_now timestamptz
) RETURNS TABLE (tenant_id text, created boolean, reinstalled boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_integration integrations%ROWTYPE;
  v_ref text := 'shopify-session:offline_' || p_shop;
  v_tenant tenants%ROWTYPE;
BEGIN
  IF p_shop !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' THEN
    RAISE EXCEPTION 'invalid shop domain' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('shopify_install:' || p_shop));

  SELECT * INTO v_integration FROM integrations i
  WHERE i.kind = 'shopify' AND i.external_id = p_shop FOR UPDATE;

  IF FOUND THEN
    UPDATE integrations SET status = 'active', uninstalled_at = NULL, purge_due_at = NULL,
      credentials_secret_ref = v_ref, scopes = p_scopes, api_version = p_api_version
    WHERE id = v_integration.id;
    SELECT * INTO v_tenant FROM tenants t WHERE t.id = v_integration.tenant_id FOR UPDATE;
    IF v_integration.status = 'uninstalled'
       OR (v_tenant.status = 'paused' AND v_tenant.paused_reason = 'app/uninstalled') THEN
      IF v_tenant.status = 'paused' AND v_tenant.paused_reason = 'app/uninstalled' THEN
        UPDATE tenants SET
          status = CASE WHEN review_until IS NULL OR review_until <= p_now
                        THEN 'active'::tenant_status ELSE 'pending_review'::tenant_status END,
          paused_at = NULL, paused_reason = NULL, uninstalled_at = NULL
        WHERE id = v_tenant.id;
      END IF;
      INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, action, target_type, target_id, after, at)
      VALUES (p_audit_id, v_tenant.id, 'shopify', p_shop, 'tenant.reinstalled', 'tenant', v_tenant.id,
              jsonb_build_object('previous_status', v_tenant.status), p_now);
      RETURN QUERY SELECT v_tenant.id, false, true;
      RETURN;
    END IF;
    RETURN QUERY SELECT v_tenant.id, false, false;
    RETURN;
  END IF;

  INSERT INTO tenants (id, name, country, data_region, timezone, currency, status, review_until)
  VALUES (p_tenant_id, left(p_name, 200), p_country, p_data_region, p_timezone, p_currency,
          'pending_review', p_now + interval '7 days');
  INSERT INTO integrations (id, tenant_id, kind, external_id, credentials_secret_ref, scopes,
                            api_version, status, installed_at)
  VALUES (p_integration_id, p_tenant_id, 'shopify', p_shop, v_ref, p_scopes, p_api_version, 'active', p_now);
  IF p_owner_email IS NOT NULL THEN
    INSERT INTO users (id, tenant_id, email, role) VALUES (p_user_id, p_tenant_id, p_owner_email, 'owner');
  END IF;
  INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, action, target_type, target_id, after, at)
  VALUES (p_audit_id, p_tenant_id, 'shopify', p_shop, 'tenant.provisioned', 'tenant', p_tenant_id,
          jsonb_build_object('country', p_country, 'data_region', p_data_region), p_now);
  RETURN QUERY SELECT p_tenant_id, true, false;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION web_login_candidates(citext) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_login_token(text, text, text, timestamptz, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_login_token(text, text, text, timestamptz, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_web_session(text, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopify_session_store(text, text, text, boolean, text, timestamptz, bytea, bytea, bytea, smallint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopify_session_load(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopify_sessions_for_shop(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopify_session_delete(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION provision_shopify_install(text, text, text, text, text, text, text, data_region, text, text, citext, text[], text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION web_login_candidates(citext) TO naaradh_app;
GRANT EXECUTE ON FUNCTION create_login_token(text, text, text, timestamptz, text, timestamptz) TO naaradh_app;
GRANT EXECUTE ON FUNCTION consume_login_token(text, text, text, timestamptz, text, text, text, timestamptz) TO naaradh_app;
GRANT EXECUTE ON FUNCTION resolve_web_session(text, timestamptz, integer) TO naaradh_app;
GRANT EXECUTE ON FUNCTION shopify_session_store(text, text, text, boolean, text, timestamptz, bytea, bytea, bytea, smallint, jsonb) TO naaradh_app;
GRANT EXECUTE ON FUNCTION shopify_session_load(text) TO naaradh_app;
GRANT EXECUTE ON FUNCTION shopify_sessions_for_shop(text) TO naaradh_app;
GRANT EXECUTE ON FUNCTION shopify_session_delete(text[]) TO naaradh_app;
GRANT EXECUTE ON FUNCTION provision_shopify_install(text, text, text, text, text, text, text, data_region, text, text, citext, text[], text, timestamptz) TO naaradh_app;
