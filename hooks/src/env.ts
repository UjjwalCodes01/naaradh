import { z } from 'zod';
import { baseEnv, loadEnv, regionPeersEnv, serviceDatabaseEnv } from '@naaradh/shared';
import { engineEnv, refineEngineEnv } from '@naaradh/engines-registry';

export const hooksEnvSchema = z
  .object({
    ...baseEnv,
    ...serviceDatabaseEnv,
    ...engineEnv,
    ...regionPeersEnv,
    PORT: z.coerce.number().int().positive().default(3002),
    HOST: z.string().default('0.0.0.0'),
    /** Public Shopify app secret (verifies X-Shopify-Hmac-Sha256). */
    SHOPIFY_API_SECRET: z.string().min(8),
    /**
     * Per-shop overrides as JSON `{ "shop.myshopify.com": "secret" }` — Phase 1's custom app on
     * Client A's store has its own secret while the public app is still in review.
     */
    SHOPIFY_WEBHOOK_SECRETS: z
      .string()
      .optional()
      .transform((s) =>
        s === undefined || s.length === 0 ? {} : (JSON.parse(s) as Record<string, string>),
      )
      .pipe(z.record(z.string().min(8))),
    /** Binds engine webhook URLs to a tenant (shared/signing.ts engineWebhookTag). */
    ENGINE_WEBHOOK_KEY: z.string().min(32),
    /** Razorpay dashboard → Webhooks secret (P2-BILL-3). Unset → /razorpay/webhooks is 404. */
    RAZORPAY_WEBHOOK_SECRET: z.string().min(8).optional(),
    /** Stripe endpoint signing secret (whsec_…), P6-BILL-1. Unset → the route answers 404. */
    STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
    /**
     * Mints and verifies every per-tenant provider webhook URL and the secret a merchant pastes
     * into the provider: one-click checkouts (`/occ`, GoKwik / Shiprocket / Razorpay Magic /
     * Cashfree) and CRMs (`/crm`, Zoho / HubSpot). Each area is domain-separated in the
     * derivation, so one area's URL says nothing about another's. Unset → those routes answer
     * 404. Rotating it rotates every merchant's URL, so it changes only alongside the re-issue
     * step in docs/runbooks/secret-rotation.md.
     */
    PROVIDER_WEBHOOK_KEY: z.string().min(32).optional(),
    PUBSUB_TOPIC_PREFIX: z.string().default('naaradh'),
    PUBSUB_EMULATOR_HOST: z.string().optional(),
    /** Requests per minute per IP before 429 — defence in depth behind Cloud Armor. */
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  })
  .superRefine(refineEngineEnv);

export type HooksEnv = z.infer<typeof hooksEnvSchema>;

export function loadHooksEnv(source: NodeJS.ProcessEnv = process.env): HooksEnv {
  return loadEnv(hooksEnvSchema, source);
}
