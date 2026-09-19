import { z } from 'zod';
import {
  baseEnv,
  databaseEnv,
  loadEnv,
  phoneHashEnv,
  redisEnv,
  staffEncryptEnv,
} from '@naaradh/shared';

/**
 * The dashboard's configuration. Deliberately absent: DATABASE_SERVICE_URL (the dashboard never
 * bypasses RLS) and every private key (no merchant-facing service can decrypt a customer
 * number — AGENTS §4; transfer numbers are only ever encrypted here, with the staff PUBLIC key).
 */
const schema = z
  .object({
    ...baseEnv,
    ...databaseEnv,
    ...redisEnv,
    ...phoneHashEnv,
    ...staffEncryptEnv,
    /** Public origin of the dashboard, for links in emails: https://app.naaradh.com */
    APP_URL: z.string().url().default('http://localhost:3000'),
    POSTMARK_TOKEN: z.string().min(10).optional(),
    MAIL_FROM: z.string().default('Naaradh <no-reply@mail.naaradh.com>'),
    /** `gcs` signs recording URLs and reads transcripts from the bucket; `dev` fakes both. */
    MEDIA_STORE: z.enum(['gcs', 'dev']).optional(),
    /** Razorpay (direct Indian merchants): the dashboard can start a subscription. */
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_PLAN_IDS: z
      .string()
      .default('{}')
      .transform((v, ctx) => {
        try {
          return z.record(z.string()).parse(JSON.parse(v));
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'must be a JSON object of plan ids',
          });
          return z.NEVER;
        }
      }),
    /** Stripe (direct USD merchants, P6-BILL-1): the dashboard can start a Checkout session. */
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_PRICE_IDS: z
      .string()
      .default('{}')
      .transform((v, ctx) => {
        try {
          return z.record(z.string().regex(/^price_[A-Za-z0-9]+$/)).parse(JSON.parse(v));
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'must be a JSON object of Stripe price ids',
          });
          return z.NEVER;
        }
      }),
    PHONE_ENC_PRIVATE_KEY: z.string().optional(),
    STAFF_ENC_PRIVATE_KEY: z.string().optional(),
    DATABASE_SERVICE_URL: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // Refused in production (a shared local .env.local may carry them for other services).
    if (env.NODE_ENV === 'production')
      for (const k of [
        'PHONE_ENC_PRIVATE_KEY',
        'STAFF_ENC_PRIVATE_KEY',
        'DATABASE_SERVICE_URL',
      ] as const)
        if (env[k] !== undefined)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [k],
            message: 'must NOT be set for the dashboard (AGENTS §4, invariants 15, 19)',
          });
    if (env.NODE_ENV === 'production' && env.POSTMARK_TOKEN === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['POSTMARK_TOKEN'],
        message: 'required in production',
      });
  });

export type WebEnv = z.infer<typeof schema>;

let cached: WebEnv | undefined;

export function env(): WebEnv {
  cached ??= loadEnv(schema);
  return cached;
}
