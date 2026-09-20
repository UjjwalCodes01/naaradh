import { z } from 'zod';
import {
  baseEnv,
  databaseEnv,
  loadEnv,
  phoneEncryptEnv,
  phoneHashEnv,
  redisEnv,
  staffEncryptEnv,
} from '@naaradh/shared';

/**
 * The api holds the PUBLIC phone key only (it ingests numbers, never reads them back) and
 * the app-role database URL. Tenant creation (the one service-role operation) lives in
 * src/bootstrap and takes its own URL so a request handler can never reach it by accident.
 */
export const apiEnvSchema = z.object({
  ...baseEnv,
  ...databaseEnv,
  ...redisEnv,
  ...phoneHashEnv,
  ...phoneEncryptEnv,
  ...staffEncryptEnv,
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  RECORDINGS_BUCKET: z.string().optional(),
  /** Razorpay direct billing (P2-BILL-3). Unset → /v1/billing/razorpay/subscribe answers 503. */
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  /** JSON: {"growth+-": "plan_…", "-+inbound_growth": "plan_…", "growth+inbound_growth": "plan_…"} */
  RAZORPAY_PLAN_IDS: z
    .string()
    .optional()
    .transform((s) =>
      s === undefined || s.length === 0 ? {} : (JSON.parse(s) as Record<string, string>),
    )
    .pipe(z.record(z.string().regex(/^plan_[A-Za-z0-9]+$/))),
  /** Stripe direct billing in USD (P6-BILL-1). Unset → /v1/billing/stripe/checkout answers 503. */
  STRIPE_SECRET_KEY: z
    .string()
    .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/)
    .optional(),
  /** JSON: {"growth": "price_…", "inbound_growth": "price_…"} — one USD price per plan code. */
  STRIPE_PRICE_IDS: z
    .string()
    .optional()
    .transform((s) =>
      s === undefined || s.length === 0 ? {} : (JSON.parse(s) as Record<string, string>),
    )
    .pipe(z.record(z.string().regex(/^price_[A-Za-z0-9]+$/))),
  /** Per secret key: requests per minute (burst). AGENTS §8: 60 rpm, burst 120. */
  RATE_LIMIT_KEY_PER_MINUTE: z.coerce.number().int().positive().default(120),
  /** Per public site key, per IP. */
  RATE_LIMIT_PUBLIC_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** Default intents/day per key when the key has no cap of its own (E-70). */
  DEFAULT_KEY_DAILY_CAP: z.coerce.number().int().positive().default(5000),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  return loadEnv(apiEnvSchema, source);
}
