import { createRazorpayClient, createStripeClient } from '@naaradh/payments';
import { Redis } from 'ioredis';
import { createDb } from '@naaradh/db';
import { loadApiEnv } from './env.js';
import { devSigner, gcsSigner } from './routes/calls.js';
import { inlineSecretStore, secretManagerStore } from './secrets.js';
import { buildServer } from './server.js';

const env = loadApiEnv();
const { db, close } = createDb({ url: env.DATABASE_URL, applicationName: 'naaradh-api' });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
// Reconnects are handled by ioredis; logged so an outage is visible, never fatal.
redis.on('error', (error) => {
  process.stderr.write(
    `${JSON.stringify({ severity: 'WARNING', message: 'redis client error', error: error.message })}\n`,
  );
});

const app = await buildServer({
  db,
  redis,
  keys: {
    hashKey: env.PHONE_HASH_KEY,
    encPublicKeyPem: env.PHONE_ENC_PUBLIC_KEY,
    encKid: env.PHONE_ENC_KID,
  },
  staffKey: { publicKeyPem: env.STAFF_ENC_PUBLIC_KEY, kid: env.STAFF_ENC_KID },
  razorpay:
    env.RAZORPAY_KEY_ID !== undefined && env.RAZORPAY_KEY_SECRET !== undefined
      ? createRazorpayClient({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET })
      : null,
  razorpayPlanIds: env.RAZORPAY_PLAN_IDS,
  stripe:
    env.STRIPE_SECRET_KEY === undefined
      ? null
      : createStripeClient({ secretKey: env.STRIPE_SECRET_KEY }),
  stripePriceIds: env.STRIPE_PRICE_IDS,
  signer: env.RECORDINGS_BUCKET === undefined ? devSigner() : gcsSigner(),
  secrets:
    env.NODE_ENV === 'production'
      ? secretManagerStore(env.GCP_PROJECT, env.GCP_REGION)
      : inlineSecretStore(),
  clock: () => new Date(),
  rateLimitKeyPerMinute: env.RATE_LIMIT_KEY_PER_MINUTE,
  rateLimitPublicPerMinute: env.RATE_LIMIT_PUBLIC_PER_MINUTE,
  defaultDailyCap: env.DEFAULT_KEY_DAILY_CAP,
  logLevel: env.LOG_LEVEL,
  trustProxyHops: env.TRUST_PROXY_HOPS,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await close();
  redis.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
