import { z } from 'zod';
import {
  baseEnv,
  databaseEnv,
  loadEnv,
  phoneHashEnv,
  shopifyTokenEnv,
  staffEncryptEnv,
} from '@naaradh/shared';
import { SHOPIFY_SCOPE_STRING } from '@naaradh/shopify-sdk';

/**
 * The embedded app's configuration. The app role only (ADR-0009): no service URL, no private
 * key. SHOPIFY_TOKEN_KEY seals the shop's offline token in Postgres (ADR-0007); the optional
 * SHOPIFY_TOKEN_KEY_PREVIOUS / SHOPIFY_TOKEN_KID_PREVIOUS (part of shopifyTokenEnv) keep
 * sessions sealed under the retiring key readable during a rotation
 * (docs/runbooks/secret-rotation.md).
 */
const schema = z
  .object({
    ...baseEnv,
    ...databaseEnv,
    ...phoneHashEnv,
    ...staffEncryptEnv,
    ...shopifyTokenEnv,
    SHOPIFY_API_KEY: z.string().min(1),
    SHOPIFY_API_SECRET: z.string().min(1),
    SHOPIFY_APP_URL: z.string().url(),
    SCOPES: z.string().default(SHOPIFY_SCOPE_STRING),
    SHOPIFY_ADMIN_API_VERSION: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .default('2026-07'),
    /** Test charges (dev stores, staging). Defaults to true outside production. */
    SHOPIFY_BILLING_TEST: z.enum(['true', 'false']).optional(),
    /** The full dashboard, linked from the app. */
    DASHBOARD_URL: z.string().url().default('https://app.naaradh.com'),
    DATABASE_SERVICE_URL: z.string().optional(),
    PHONE_ENC_PRIVATE_KEY: z.string().optional(),
    STAFF_ENC_PRIVATE_KEY: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // Refused in production (a shared local .env.local may carry them for other services).
    if (env.NODE_ENV === 'production')
      for (const k of [
        'DATABASE_SERVICE_URL',
        'PHONE_ENC_PRIVATE_KEY',
        'STAFF_ENC_PRIVATE_KEY',
      ] as const)
        if (env[k] !== undefined)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [k],
            message: 'must NOT be set for the Shopify app (ADR-0009)',
          });
  });

export type ShopifyAppEnv = z.infer<typeof schema>;

let cached: ShopifyAppEnv | undefined;
export function env(): ShopifyAppEnv {
  cached ??= loadEnv(schema);
  return cached;
}

export function billingTest(): boolean {
  const e = env();
  return (e.SHOPIFY_BILLING_TEST ?? (e.NODE_ENV === 'production' ? 'false' : 'true')) === 'true';
}
