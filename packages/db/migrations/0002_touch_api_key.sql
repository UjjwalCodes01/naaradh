-- The api (app role, no tenant context yet at auth time) records key usage through a
-- SECURITY DEFINER function, the same pattern as touch_number().
CREATE OR REPLACE FUNCTION touch_api_key(p_api_key_id text, p_used_at timestamptz)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE api_keys SET last_used_at = GREATEST(COALESCE(last_used_at, p_used_at), p_used_at)
  WHERE id = p_api_key_id;
$$;
REVOKE ALL ON FUNCTION touch_api_key(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION touch_api_key(text, timestamptz) TO naaradh_app, naaradh_service;
