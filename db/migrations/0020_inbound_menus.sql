ALTER TABLE "inbound_profiles" ADD COLUMN "menu" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_profiles" ADD CONSTRAINT "inbound_profiles_menu_array" CHECK (jsonb_typeof("inbound_profiles"."menu") = 'array' and jsonb_array_length("inbound_profiles"."menu") <= 6);--> statement-breakpoint
-- 0020 (hand-written part) — P7-INB-1 keypad menus. The menu is part of what the caller hears,
-- so changing it must bump the version stamped on each call, like the greeting. Same function as
-- 0004 with `menu` added to the compared columns.
CREATE OR REPLACE FUNCTION inbound_profiles_bump_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.greeting, NEW.persona, NEW.business_hours, NEW.tools_enabled, NEW.pinned_facts,
      NEW.closed_message, NEW.locale, NEW.agent_cancel_enabled, NEW.transfer_target_id, NEW.menu)
     IS DISTINCT FROM
     (OLD.greeting, OLD.persona, OLD.business_hours, OLD.tools_enabled, OLD.pinned_facts,
      OLD.closed_message, OLD.locale, OLD.agent_cancel_enabled, OLD.transfer_target_id, OLD.menu) THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;
