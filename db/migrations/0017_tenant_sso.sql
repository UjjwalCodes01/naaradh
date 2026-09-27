CREATE TYPE "public"."sso_status" AS ENUM('testing', 'active', 'disabled');--> statement-breakpoint
CREATE TABLE "tenant_sso" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"slug" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" "bytea" NOT NULL,
	"client_secret_iv" "bytea" NOT NULL,
	"client_secret_tag" "bytea" NOT NULL,
	"client_secret_kid" smallint NOT NULL,
	"email_domains" text[] NOT NULL,
	"status" "sso_status" DEFAULT 'testing' NOT NULL,
	"enforced" boolean DEFAULT false NOT NULL,
	"last_success_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_sso_id_format" CHECK ("id" ~ '^sso_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "tenant_sso_slug_format" CHECK ("tenant_sso"."slug" ~ '^[a-z0-9]{16}$'),
	CONSTRAINT "tenant_sso_issuer_https" CHECK ("tenant_sso"."issuer" ~ '^https://[^/]+'),
	CONSTRAINT "tenant_sso_domains" CHECK (cardinality("tenant_sso"."email_domains") between 1 and 20),
	CONSTRAINT "tenant_sso_enforced_needs_proof" CHECK (not "tenant_sso"."enforced" or ("tenant_sso"."status" = 'active' and "tenant_sso"."last_success_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "tenant_sso" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_sso" ADD CONSTRAINT "tenant_sso_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_sso_tenant_uq" ON "tenant_sso" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_sso_slug_uq" ON "tenant_sso" USING btree ("slug");--> statement-breakpoint
-- 0017 (hand-written part) — P7-ENT-1: single sign-on for the dashboard (OpenID Connect).
ALTER TABLE tenant_sso FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_sso
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
-- Owners configure it from the dashboard. Switched off, never deleted: status 'disabled'.
GRANT SELECT, INSERT, UPDATE ON tenant_sso TO naaradh_app, naaradh_service;
REVOKE DELETE, TRUNCATE ON tenant_sso FROM naaradh_app, naaradh_service;
--> statement-breakpoint
CREATE TRIGGER tenant_sso_set_updated_at BEFORE UPDATE ON tenant_sso
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- The provider behind a sign-in link, read before any tenant is known — the same narrow
-- SECURITY DEFINER pattern as the magic link (0009). The secret leaves sealed; only the web app
-- holds the key to open it.
CREATE OR REPLACE FUNCTION web_sso_by_slug(p_slug text)
RETURNS TABLE (
  tenant_id text, tenant_name text, issuer text, client_id text,
  client_secret_enc bytea, client_secret_iv bytea, client_secret_tag bytea, client_secret_kid smallint,
  email_domains text[], status sso_status
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.tenant_id, t.name, s.issuer, s.client_id,
         s.client_secret_enc, s.client_secret_iv, s.client_secret_tag, s.client_secret_kid,
         s.email_domains, s.status
  FROM tenant_sso s JOIN tenants t ON t.id = s.tenant_id
  WHERE s.slug = p_slug AND s.status IN ('testing', 'active') AND t.status <> 'uninstalled';
$$;
--> statement-breakpoint

-- Open a session for an address the provider has vouched for. Called only after the ID token
-- has been verified in the app; this function re-checks what the database can see: the provider
-- is still on, the address is inside its domains, and the person is an enabled user of THIS
-- tenant. It never creates a user. The first success proves the configuration and promotes it
-- from 'testing' to 'active' — the only way enforcement can become possible.
CREATE OR REPLACE FUNCTION open_sso_session(
  p_tenant_id text, p_email citext, p_session_id text, p_session_hash text,
  p_session_expires_at timestamptz, p_user_agent text, p_ip_hash text, p_audit_id text, p_now timestamptz
) RETURNS TABLE (session_id text, user_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user text; v_domain text;
BEGIN
  v_domain := lower(split_part(p_email::text, '@', 2));
  IF NOT EXISTS (
    SELECT 1 FROM tenant_sso s JOIN tenants t ON t.id = s.tenant_id
    WHERE s.tenant_id = p_tenant_id AND s.status IN ('testing', 'active')
      AND v_domain = ANY (s.email_domains) AND t.status <> 'uninstalled'
  ) THEN
    RETURN;
  END IF;
  SELECT u.id INTO v_user FROM users u
  WHERE u.tenant_id = p_tenant_id AND u.email = p_email AND u.disabled_at IS NULL;
  IF v_user IS NULL THEN RETURN; END IF;
  INSERT INTO web_sessions (id, tenant_id, user_id, session_hash, expires_at, last_seen_at, user_agent, ip_hash)
  VALUES (p_session_id, p_tenant_id, v_user, p_session_hash, p_session_expires_at, p_now,
          left(p_user_agent, 200), p_ip_hash);
  UPDATE users SET last_login_at = p_now WHERE id = v_user;
  UPDATE tenant_sso
     SET last_success_at = p_now,
         status = CASE WHEN status = 'testing' THEN 'active'::sso_status ELSE status END
   WHERE tenant_id = p_tenant_id;
  INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, action, target_type, target_id, after, ip_hash, at)
  VALUES (p_audit_id, p_tenant_id, 'user', v_user, 'user.signed_in', 'web_session', p_session_id,
          '{"method":"sso"}'::jsonb, p_ip_hash, p_now);
  RETURN QUERY SELECT p_session_id, v_user;
END;
$$;
--> statement-breakpoint

-- Magic-link candidates now say when a candidate must use SSO instead: enforcement is on, the
-- address is inside the provider's domains, and the user is not an owner (owners keep the email
-- link as the way back in when a provider breaks). The return type changes, so drop and recreate.
DROP FUNCTION web_login_candidates(citext);
CREATE FUNCTION web_login_candidates(p_email citext)
RETURNS TABLE (user_id text, tenant_id text, tenant_name text, sso_slug text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.tenant_id, t.name,
         CASE WHEN s.enforced AND s.status = 'active' AND u.role <> 'owner'
                   AND lower(split_part(u.email::text, '@', 2)) = ANY (s.email_domains)
              THEN s.slug END
  FROM users u
  JOIN tenants t ON t.id = u.tenant_id
  LEFT JOIN tenant_sso s ON s.tenant_id = u.tenant_id
  WHERE u.email = p_email AND u.disabled_at IS NULL AND t.status <> 'uninstalled'
  ORDER BY t.name, u.id
  LIMIT 10;
$$;
--> statement-breakpoint

-- A link issued before enforcement was switched on must not still work for its 15 minutes:
-- spending it re-checks, and refuses exactly the users the candidates function now withholds.
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
  IF EXISTS (
    SELECT 1 FROM users u JOIN tenant_sso s ON s.tenant_id = u.tenant_id
    WHERE u.id = v_user AND s.enforced AND s.status = 'active' AND u.role <> 'owner'
      AND lower(split_part(u.email::text, '@', 2)) = ANY (s.email_domains)
  ) THEN
    RETURN;
  END IF;
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
REVOKE ALL ON FUNCTION web_sso_by_slug(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION open_sso_session(text, citext, text, text, timestamptz, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION web_login_candidates(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION web_sso_by_slug(text) TO naaradh_app;
GRANT EXECUTE ON FUNCTION open_sso_session(text, citext, text, text, timestamptz, text, text, text, timestamptz) TO naaradh_app;
GRANT EXECUTE ON FUNCTION web_login_candidates(citext) TO naaradh_app;
