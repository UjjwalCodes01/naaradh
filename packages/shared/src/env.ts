import { z } from 'zod';

/**
 * Validate process.env at startup against a per-service schema. Fails fast with the NAMES
 * of the missing/invalid variables — never their values — so a misconfigured deploy dies
 * at boot rather than at the first call.
 */
export function loadEnv<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  source: NodeJS.ProcessEnv = process.env,
): T {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const problems = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new Error(`Environment is invalid:\n  ${problems.join('\n  ')}`);
}

/** Common pieces every service shares. */
export const baseEnv = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  GCP_PROJECT: z.string().min(1).default('naaradh-local'),
  GCP_REGION: z.string().min(1).default('asia-south1'),
};

export const databaseEnv = {
  /** Pooled endpoint, naaradh_app. */
  DATABASE_URL: z.string().url(),
};

export const serviceDatabaseEnv = {
  /** Pooled endpoint, naaradh_service (BYPASSRLS). Only hooks and cross-tenant workers. */
  DATABASE_SERVICE_URL: z.string().url(),
};

export const redisEnv = {
  REDIS_URL: z.string().url(),
};

export const phoneHashEnv = {
  PHONE_HASH_KEY: z.string().min(32, 'PHONE_HASH_KEY must be at least 32 characters'),
};

/** Ingestion services: encrypt only. */
export const phoneEncryptEnv = {
  PHONE_ENC_PUBLIC_KEY: z.string().includes('BEGIN PUBLIC KEY'),
  PHONE_ENC_KID: z.coerce.number().int().positive().default(1),
};

/** Dispatcher / results-consumer: decrypt. */
export const phoneDecryptEnv = {
  PHONE_ENC_PRIVATE_KEY: z.string().includes('BEGIN PRIVATE KEY'),
};

/**
 * Staff key pair (ADR-0006, invariant 19): transfer-target and fallback-forward numbers belong
 * to the merchant's staff, not customers. They are encrypted with this pair so the voice
 * runtime can decrypt them at transfer time while holding NO key that opens a customer number.
 */
export const staffEncryptEnv = {
  STAFF_ENC_PUBLIC_KEY: z.string().includes('BEGIN PUBLIC KEY'),
  STAFF_ENC_KID: z.coerce.number().int().positive().default(1),
};

export const staffDecryptEnv = {
  STAFF_ENC_PRIVATE_KEY: z.string().includes('BEGIN PRIVATE KEY'),
};

/** Shopify offline tokens at rest (ADR-0007): the Shopify app and the workers that call Shopify. */
export const shopifyTokenEnv = {
  SHOPIFY_TOKEN_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'SHOPIFY_TOKEN_KEY must be 32 bytes, base64',
    ),
  SHOPIFY_TOKEN_KID: z.coerce.number().int().positive().default(1),
};
