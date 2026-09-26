-- P5-CRM-1/2: Zoho and HubSpot lead webhooks land in webhook_events like any other source.
-- Enum values only; webhook_events already has its RLS policy (0001) and it is unchanged.
ALTER TYPE "public"."webhook_source" ADD VALUE 'zoho';--> statement-breakpoint
ALTER TYPE "public"."webhook_source" ADD VALUE 'hubspot';
