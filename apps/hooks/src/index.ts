import { createServiceDb } from '@naaradh/db/service';
import { EngineRegistry } from '@naaradh/engines-registry';
import { loadHooksEnv } from './env.js';
import { createPubSubPublisher } from './pubsub.js';
import { buildServer } from './server.js';

const env = loadHooksEnv();

const { db, close } = createServiceDb({
  url: env.DATABASE_SERVICE_URL,
  applicationName: 'naaradh-hooks',
});
const publisher = createPubSubPublisher(env.GCP_PROJECT, env.PUBSUB_TOPIC_PREFIX);
if (env.PUBSUB_EMULATOR_HOST !== undefined) await publisher.ensureTopics();

const registry = new EngineRegistry({ env });

const app = await buildServer({
  db,
  publisher,
  registry,
  shopifySecretFor: (shop) => env.SHOPIFY_WEBHOOK_SECRETS[shop] ?? env.SHOPIFY_API_SECRET,
  engineWebhookKey: env.ENGINE_WEBHOOK_KEY,
  razorpayWebhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? null,
  rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
  logLevel: env.LOG_LEVEL,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await publisher.close();
  await close();
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
