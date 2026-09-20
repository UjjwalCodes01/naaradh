-- 0011 — Erasure reaches agent_actions (audit 2026-09-14).
--
-- agent_actions is append-only (0004): history of what the agent did must not change. But
-- `args` carries the caller's own words (an address they read out, a ticket summary) and
-- `result` carries order views, so an erasure request (DPDP, Shopify customers/redact) must be
-- able to blank exactly those two columns and nothing else. The trigger now allows that one
-- shape of update — both columns set to the erasure marker, every other column unchanged —
-- and a SECURITY DEFINER function performs it for the tenant in context, since neither role
-- holds UPDATE on the table and never will.

CREATE OR REPLACE FUNCTION agent_actions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent_actions is append-only (invariant: audit history)' USING ERRCODE = '42501';
  END IF;
  IF NEW.args = '{"erased": true}'::jsonb AND NEW.result = '{"erased": true}'::jsonb
     AND NEW.id = OLD.id AND NEW.tenant_id = OLD.tenant_id AND NEW.attempt_id = OLD.attempt_id
     AND NEW.tool = OLD.tool AND NEW.status = OLD.status
     AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id
     AND NEW.ticket_id IS NOT DISTINCT FROM OLD.ticket_id
     AND NEW.parent_action_id IS NOT DISTINCT FROM OLD.parent_action_id
     AND NEW.tool_call_id IS NOT DISTINCT FROM OLD.tool_call_id
     AND NEW.confirm_token_hash IS NOT DISTINCT FROM OLD.confirm_token_hash
     AND NEW.token_expires_at IS NOT DISTINCT FROM OLD.token_expires_at
     AND NEW.latency_ms IS NOT DISTINCT FROM OLD.latency_ms
     AND NEW.at = OLD.at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'agent_actions is append-only; only erasure may blank args/result' USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS agent_actions_append_only ON agent_actions;
CREATE TRIGGER agent_actions_append_only BEFORE UPDATE OR DELETE ON agent_actions
  FOR EACH ROW EXECUTE FUNCTION agent_actions_guard();
--> statement-breakpoint

-- Blank the caller's words on the given attempts of the tenant in context. Returns the number
-- of rows erased (rows already erased are skipped so the erasure is idempotent).
CREATE OR REPLACE FUNCTION erase_agent_actions(p_attempt_ids text[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant text := app_tenant_id(); v_n integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'erase_agent_actions requires a tenant context' USING ERRCODE = '42501';
  END IF;
  UPDATE agent_actions a
  SET args = '{"erased": true}'::jsonb, result = '{"erased": true}'::jsonb
  WHERE a.tenant_id = v_tenant AND a.attempt_id = ANY(p_attempt_ids)
    AND NOT (a.args ? 'erased');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION erase_agent_actions(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_agent_actions(text[]) TO naaradh_app, naaradh_service;
