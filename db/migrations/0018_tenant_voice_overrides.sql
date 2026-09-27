ALTER TABLE "tenants" ADD COLUMN "voice_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_voice_overrides_object" CHECK (jsonb_typeof("tenants"."voice_overrides") = 'object');--> statement-breakpoint
-- 0018 (hand-written part) — P7-ENT-1 custom voices. No grant change, deliberately: the app
-- role's UPDATE on tenants is a column list (0001) and voice_overrides is not on it. Only staff,
-- through the service role, set a voice — it means nothing until it is provisioned with the vendor.
SELECT 1;
