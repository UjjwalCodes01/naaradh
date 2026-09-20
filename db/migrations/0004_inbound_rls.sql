-- 0004 — Inbound (ADR-0006): RLS, grants, guards and the one pre-tenant lookup.
--
-- Same discipline as 0001: every tenant table is FORCE RLS with app_tenant_id(), grants are
-- explicit, agent_actions is append-only at grant AND trigger level. Nothing here uses the
-- enum values added in 0003 (ALTER TYPE ... ADD VALUE cannot be used in the transaction that
-- adds it, and all pending migrations run in one transaction).

ALTER TABLE inbound_profiles    FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_articles  FORCE ROW LEVEL SECURITY;
ALTER TABLE orders              FORCE ROW LEVEL SECURITY;
ALTER TABLE support_tickets     FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_actions       FORCE ROW LEVEL SECURITY;
ALTER TABLE order_actions       FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON inbound_profiles
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON knowledge_articles
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON support_tickets
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON agent_actions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON order_actions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- Grants. No DELETE anywhere: knowledge is archived, tickets are resolved, orders are erased
-- (tombstoned), actions are history.
GRANT SELECT, INSERT, UPDATE ON inbound_profiles, knowledge_articles, orders, support_tickets, order_actions
  TO naaradh_app, naaradh_service;
GRANT SELECT, INSERT ON agent_actions TO naaradh_app, naaradh_service;
REVOKE UPDATE, DELETE, TRUNCATE ON agent_actions FROM naaradh_app, naaradh_service;
REVOKE DELETE, TRUNCATE ON inbound_profiles, knowledge_articles, orders, support_tickets, order_actions
  FROM naaradh_app, naaradh_service;
--> statement-breakpoint

CREATE TRIGGER agent_actions_append_only BEFORE UPDATE OR DELETE ON agent_actions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inbound_profiles','knowledge_articles','orders','support_tickets','order_actions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                   t || '_set_updated_at', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Invariant 16: an inbound call's tenant comes only from the number that was called. This is
-- the single pre-context lookup the voice runtime makes, exposed as a narrow SECURITY DEFINER
-- function instead of giving the request path the service role.
CREATE OR REPLACE FUNCTION resolve_inbound_number(p_e164 text)
RETURNS TABLE (
  number_id text, tenant_id text, inbound_profile_id text, engine text,
  number_status number_status, inbound_enabled boolean, tenant_status tenant_status
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT n.id, n.tenant_id, n.inbound_profile_id, n.engine, n.status, n.inbound_enabled, t.status
  FROM numbers n
  LEFT JOIN tenants t ON t.id = n.tenant_id
  WHERE n.e164 = p_e164;
$$;
REVOKE ALL ON FUNCTION resolve_inbound_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_inbound_number(text) TO naaradh_app, naaradh_service;
--> statement-breakpoint

-- A number may only be answered by a profile of the tenant that owns the number, and a
-- profile may only transfer to its own tenant's targets. Enforced below the app, because a
-- cross-tenant link here would put one merchant's customers through another's agent.
CREATE OR REPLACE FUNCTION numbers_profile_same_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE owner text;
BEGIN
  IF NEW.inbound_profile_id IS NOT NULL THEN
    SELECT p.tenant_id INTO owner FROM inbound_profiles p WHERE p.id = NEW.inbound_profile_id;
    IF owner IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'number % and inbound profile % belong to different tenants', NEW.id, NEW.inbound_profile_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER numbers_profile_same_tenant BEFORE INSERT OR UPDATE OF inbound_profile_id, tenant_id ON numbers
  FOR EACH ROW EXECUTE FUNCTION numbers_profile_same_tenant();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION inbound_profiles_target_same_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE owner text;
BEGIN
  IF NEW.transfer_target_id IS NOT NULL THEN
    SELECT tt.tenant_id INTO owner FROM transfer_targets tt WHERE tt.id = NEW.transfer_target_id;
    IF owner IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'transfer target % is not a target of tenant %', NEW.transfer_target_id, NEW.tenant_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inbound_profiles_target_same_tenant BEFORE INSERT OR UPDATE OF transfer_target_id ON inbound_profiles
  FOR EACH ROW EXECUTE FUNCTION inbound_profiles_target_same_tenant();
--> statement-breakpoint

-- Profiles are versioned: any content change bumps the version the next call will stamp.
CREATE OR REPLACE FUNCTION inbound_profiles_bump_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.greeting, NEW.persona, NEW.business_hours, NEW.tools_enabled, NEW.pinned_facts,
      NEW.closed_message, NEW.locale, NEW.agent_cancel_enabled, NEW.transfer_target_id)
     IS DISTINCT FROM
     (OLD.greeting, OLD.persona, OLD.business_hours, OLD.tools_enabled, OLD.pinned_facts,
      OLD.closed_message, OLD.locale, OLD.agent_cancel_enabled, OLD.transfer_target_id) THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inbound_profiles_bump_version BEFORE UPDATE ON inbound_profiles
  FOR EACH ROW EXECUTE FUNCTION inbound_profiles_bump_version();
--> statement-breakpoint

COMMENT ON TABLE agent_actions IS 'APPEND-ONLY. Every voice-agent tool call: args (scrubbed), decision, result. Two-step tokens are spendable once (partial unique on parent_action_id).';
COMMENT ON TABLE orders IS 'Minimal order cache for inbound lookups. No names, no addresses. phone_hash / pincode_hash only.';
COMMENT ON FUNCTION resolve_inbound_number(text) IS 'Invariant 16: the tenant of an inbound call comes only from the called number.';
