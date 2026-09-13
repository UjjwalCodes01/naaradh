import { z } from 'zod';
import { baseEnv, loadEnv, serviceDatabaseEnv } from '@naaradh/shared';
import { engineEnv } from '@naaradh/engines-registry';

export const hooksEnvSchema = z.object({
  ...baseEnv,
  ...serviceDatabaseEnv,
  ...engineEnv,
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
  PUBSUB_TOPIC_PREFIX: z.string().default('naaradh'),
  PUBSUB_EMULATOR_HOST: z.string().optional(),
  /** Requests per minute per IP before 429 — defence in depth behind Cloud Armor. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
});

export type HooksEnv = z.infer<typeof hooksEnvSchema>;

export function loadHooksEnv(source: NodeJS.ProcessEnv = process.env): HooksEnv {
  return loadEnv(hooksEnvSchema, source);
}
