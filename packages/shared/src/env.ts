import { z } from 'zod';
import { parseSecretKey } from './secretbox.js';

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
  /**
   * How many proxies sit in front of the service, i.e. how many trailing X-Forwarded-For
   * entries are ours (Cloud Run's front end + the external HTTPS load balancer = 2). Only that
   * many are trusted when deriving the client IP for rate limits and API-key IP allow-lists;
   * `trustProxy: true` would let any client spoof its address with a header. 0 = no proxy.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
};

/** Fastify's `trustProxy` option from TRUST_PROXY_HOPS: never `true`. */
export function trustProxyOf(hops: number | undefined): false | number {
  return hops === undefined || hops <= 0 ? false : hops;
}

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

/**
 * Shopify offline tokens at rest (ADR-0007): the Shopify app and the workers that call Shopify.
 *
 * Rotation (docs/runbooks/secret-rotation.md): set the NEW key as `SHOPIFY_TOKEN_KEY` /
 * `SHOPIFY_TOKEN_KID` and the key being retired as `*_PREVIOUS`. Sealing always uses the
 * current key; opening tries the kid stamped on the row, so rows sealed under either key keep
 * working while `rotate-shopify-token-key` re-seals them. Drop the `*_PREVIOUS` pair once the
 * job reports nothing left on the old kid.
 */
export const shopifyTokenEnv = {
  SHOPIFY_TOKEN_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'SHOPIFY_TOKEN_KEY must be 32 bytes, base64',
    ),
  SHOPIFY_TOKEN_KID: z.coerce.number().int().positive().default(1),
  SHOPIFY_TOKEN_KEY_PREVIOUS: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'SHOPIFY_TOKEN_KEY_PREVIOUS must be 32 bytes, base64',
    )
    .optional(),
  SHOPIFY_TOKEN_KID_PREVIOUS: z.coerce.number().int().positive().optional(),
};

export interface ShopifyTokenKeyringEnv {
  readonly SHOPIFY_TOKEN_KEY: string;
  readonly SHOPIFY_TOKEN_KID: number;
  readonly SHOPIFY_TOKEN_KEY_PREVIOUS?: string | undefined;
  readonly SHOPIFY_TOKEN_KID_PREVIOUS?: number | undefined;
}

export interface ShopifyTokenKeyring {
  /** kid → 32-byte key: the current key and, during a rotation, the previous one. */
  readonly keys: ReadonlyMap<number, Buffer>;
  /** The kid every NEW seal is made with. */
  readonly currentKid: number;
}

/**
 * The keyring both holders of SHOPIFY_TOKEN_KEY build at boot. The cross-field rules a zod
 * field cannot express live here: the previous key and kid come together or not at all, and
 * the previous kid must differ from the current one (two keys under one kid would make the
 * kid stamped on a row meaningless).
 */
export function shopifyTokenKeyring(env: ShopifyTokenKeyringEnv): ShopifyTokenKeyring {
  const keys = new Map<number, Buffer>([
    [env.SHOPIFY_TOKEN_KID, parseSecretKey(env.SHOPIFY_TOKEN_KEY)],
  ]);
  const prevKey = env.SHOPIFY_TOKEN_KEY_PREVIOUS;
  const prevKid = env.SHOPIFY_TOKEN_KID_PREVIOUS;
  if ((prevKey === undefined) !== (prevKid === undefined)) {
    throw new Error(
      'SHOPIFY_TOKEN_KEY_PREVIOUS and SHOPIFY_TOKEN_KID_PREVIOUS must be set together',
    );
  }
  if (prevKey !== undefined && prevKid !== undefined) {
    if (prevKid === env.SHOPIFY_TOKEN_KID) {
      throw new Error('SHOPIFY_TOKEN_KID_PREVIOUS must differ from SHOPIFY_TOKEN_KID');
    }
    keys.set(prevKid, parseSecretKey(prevKey));
  }
  return { keys, currentKid: env.SHOPIFY_TOKEN_KID };
}
