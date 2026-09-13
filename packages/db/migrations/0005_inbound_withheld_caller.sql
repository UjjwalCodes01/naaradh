ALTER TABLE "call_attempts" ALTER COLUMN "contact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "call_attempts" ALTER COLUMN "phone_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_actions_tool_call_uq" ON "agent_actions" USING btree ("attempt_id","tool_call_id") WHERE "agent_actions"."tool_call_id" is not null;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_party_known" CHECK (("call_attempts"."direction" = 'outbound' and "call_attempts"."contact_id" is not null and "call_attempts"."phone_hash" is not null) or ("call_attempts"."direction" = 'inbound' and ("call_attempts"."phone_hash" is not null or "call_attempts"."caller_withheld")));