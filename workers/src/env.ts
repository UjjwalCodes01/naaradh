import { z } from 'zod';
import {
  baseEnv,
  databaseEnv,
  loadEnv,
  phoneDecryptEnv,
  phoneEncryptEnv,
  phoneHashEnv,
  redisEnv,
  regionPeersEnv,
  serviceDatabaseEnv,
  shopifyTokenEnv,
} from '@naaradh/shared';
import { engineEnv, refineEngineEnv } from '@naaradh/engines-registry';

export const WORKERS = [
  'intents',
  'dispatcher',
  'results',
  'reconcile',
  'deliveries',
  'actions',
  'writebacks',
  'complaints',
  'retention',
  'billing',
  'notifications',
  'analytics',
  'all',
] as const;
export type WorkerName = (typeof WORKERS)[number];

/** Roles that dial, receive engine events or poll the engine (dispatcher, results, reconcile). */
export const ENGINE_ROLES: ReadonlySet<WorkerName> = new Set([
  'dispatcher',
  'results',
  'reconcile',
  'all',
]);

/**
 * One binary, one env schema, several roles selected by WORKER. Keys are the exception:
 * the PRIVATE phone key is required only by the dispatcher and results roles (AGENTS §4),
 * so a misconfigured intents-consumer with the private key mounted fails loudly at boot.
 */
export const workersEnvSchema = z
  .object({
    ...baseEnv,
    ...databaseEnv,
    ...serviceDatabaseEnv,
    ...redisEnv,
    ...engineEnv,
    ...regionPeersEnv,
    ...phoneHashEnv,
    ...phoneEncryptEnv,
    PHONE_ENC_PRIVATE_KEY: phoneDecryptEnv.PHONE_ENC_PRIVATE_KEY.optional(),
    WORKER: z.enum(WORKERS).default('all'),
    /**
     * Shopify offline tokens (ADR-0007): the key that seals `shopify_sessions`, and the app's
     * client id/secret for refreshing expiring tokens. Needed by roles that call Shopify.
     */
    SHOPIFY_TOKEN_KEY: shopifyTokenEnv.SHOPIFY_TOKEN_KEY.optional(),
    SHOPIFY_TOKEN_KID: shopifyTokenEnv.SHOPIFY_TOKEN_KID,
    /** The retiring key during a rotation (docs/runbooks/secret-rotation.md); opens only, never seals. */
    SHOPIFY_TOKEN_KEY_PREVIOUS: shopifyTokenEnv.SHOPIFY_TOKEN_KEY_PREVIOUS,
    SHOPIFY_TOKEN_KID_PREVIOUS: shopifyTokenEnv.SHOPIFY_TOKEN_KID_PREVIOUS,
    SHOPIFY_API_KEY: z.string().min(1).optional(),
    SHOPIFY_API_SECRET: z.string().min(1).optional(),
    /** Postmark server token; without it merchant emails go to an in-memory outbox (dev only). */
    POSTMARK_TOKEN: z.string().min(10).optional(),
    MAIL_FROM: z.string().default('Naaradh <no-reply@mail.naaradh.com>'),
    DASHBOARD_URL: z.string().url().default('http://localhost:3000'),
    /** Cloud Run sets PORT and expects a listener; health.ts serves /healthz and /readyz there. */
    PORT: z.coerce.number().int().positive().optional(),
    PUBSUB_TOPIC_PREFIX: z.string().default('naaradh'),
    PUBSUB_EMULATOR_HOST: z.string().optional(),
    /** Public base URL of the hooks service, for engine webhook URLs. */
    HOOKS_BASE_URL: z.string().url().default('http://localhost:3002'),
    /** Public base URL of voice, for outbound agents' tool URLs. */
    VOICE_BASE_URL: z.string().url().default('http://localhost:3003'),
    ENGINE_WEBHOOK_KEY: z.string().min(32),
    RECORDINGS_BUCKET: z.string().optional(),
    /** Pinned Admin GraphQL version for write-backs (P1-SHOP-2); bump per shopify-api-upgrade runbook. */
    SHOPIFY_ADMIN_API_VERSION: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .default('2026-07'),
    /**
     * `live` calls the merchant's store; `recording` only records the plan. Defaults to live in
     * production and recording everywhere else — dev and CI never write to a real store.
     */
    SHOPIFY_WRITEBACK: z.enum(['live', 'recording']).optional(),
    /** Fire the Flow trigger after a write-back (P2-SHOP-7); on once its extension is deployed. */
    SHOPIFY_FLOW_TRIGGER: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /** Razorpay (direct Indian merchants, P2-BILL-3). Unset → Razorpay postings wait. */
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    /** Stripe (dollar merchants, P6-BILL-1). Unset → Stripe postings and events wait. */
    STRIPE_SECRET_KEY: z
      .string()
      .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, 'a Stripe secret or restricted key')
      .optional(),
    /** Platform-wide daily safety caps, paise. */
    ENGINE_DAILY_CAP_PAISE: z.coerce.number().int().positive().default(50_000_00),
    GLOBAL_DAILY_CAP_PAISE: z.coerce.number().int().positive().default(200_000_00),
    /** The same caps for engines that bill in dollars (Retell, P6), in cents. */
    ENGINE_DAILY_CAP_USD_CENTS: z.coerce.number().int().positive().default(600_00),
    GLOBAL_DAILY_CAP_USD_CENTS: z.coerce.number().int().positive().default(2_400_00),
    /**
     * Recipient regions screened against the do-not-call registries loaded by `dnc-load`
     * (P6-CMP-1): "US,GB". Any other region keeps the fail-closed placeholder, so every
     * marketing call there is refused until its own screening exists (ADR-0010 §6).
     */
    DND_REGISTRY_REGIONS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((r) => r.trim().toUpperCase())
          .filter((r) => r !== ''),
      )
      .refine((rs) => rs.every((r) => r === 'US' || r === 'GB'), 'only US and GB registries exist'),
    ENGINE_MAX_CONCURRENCY: z.coerce.number().int().positive().default(20),
    DISPATCH_BATCH: z.coerce.number().int().positive().max(100).default(10),
    DISPATCH_POLL_MS: z.coerce.number().int().positive().default(1000),
    RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    /**
     * Nightly BigQuery export (P2-INF-2). Unset outside production → an in-memory sink, so
     * `pnpm dev` and CI never need BigQuery; production requires it for WORKER=analytics.
     */
    BIGQUERY_DATASET: z.string().min(1).optional(),
    BIGQUERY_TABLE: z.string().min(1).default('daily_call_facts'),
    BIGQUERY_LOCATION: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    // Only these roles talk to a voice engine, and only they hold its credentials
    // (infra/locals.tf secret_holders); the others must boot without them.
    if (ENGINE_ROLES.has(env.WORKER)) refineEngineEnv(env, ctx);
    const needsPrivate =
      env.WORKER === 'dispatcher' ||
      env.WORKER === 'results' ||
      env.WORKER === 'reconcile' ||
      env.WORKER === 'all';
    if (needsPrivate && env.PHONE_ENC_PRIVATE_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PHONE_ENC_PRIVATE_KEY'],
        message: `required for WORKER=${env.WORKER}`,
      });
    }
    if (!needsPrivate && env.PHONE_ENC_PRIVATE_KEY !== undefined && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PHONE_ENC_PRIVATE_KEY'],
        message: `must NOT be mounted for WORKER=${env.WORKER} (AGENTS §4)`,
      });
    }
    const callsShopify = ['writebacks', 'actions', 'billing', 'reconcile', 'all'].includes(
      env.WORKER,
    );
    if (env.NODE_ENV === 'production' && callsShopify)
      for (const k of ['SHOPIFY_TOKEN_KEY', 'SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET'] as const)
        if (env[k] === undefined)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [k],
            message: `required for WORKER=${env.WORKER} in production (ADR-0007)`,
          });
    if (
      env.NODE_ENV === 'production' &&
      (env.WORKER === 'analytics' || env.WORKER === 'all') &&
      env.BIGQUERY_DATASET === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BIGQUERY_DATASET'],
        message: `required for WORKER=${env.WORKER} in production`,
      });
    }
    // Merchant alerts (capped, paused, complaints) must actually leave the building in production.
    if (
      env.NODE_ENV === 'production' &&
      (env.WORKER === 'notifications' || env.WORKER === 'all') &&
      env.POSTMARK_TOKEN === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['POSTMARK_TOKEN'],
        message: `required for WORKER=${env.WORKER} in production`,
      });
    }
  });

export type WorkersEnv = z.infer<typeof workersEnvSchema>;

export function loadWorkersEnv(source: NodeJS.ProcessEnv = process.env): WorkersEnv {
  return loadEnv(workersEnvSchema, source);
}
