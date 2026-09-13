import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { createDb } from '@naaradh/db';
import { createServiceDb } from '@naaradh/db/service';
import { createLogger, parseSecretKey, systemClock } from '@naaradh/shared';
import { EngineRegistry } from '@naaradh/engines-registry';
import { createPubSubBus } from './bus.js';
import type { WorkerContext } from './context.js';
import { createRazorpayClient } from '@naaradh/payments';
import { runActions } from './actions/index.js';
import { handleBillingEvent, runBilling } from './billing/index.js';
import { runComplaints } from './complaints/index.js';
import { runRetention } from './retention/index.js';
import { startHealthServer } from './health.js';
import { shopifyTokenResolver } from './shopify-tokens.js';
import { runNotifications } from './notifications/index.js';
import { memoryMailer, postmarkMailer } from '@naaradh/notify';
import { runDeliveries } from './deliveries/index.js';
import { inlineSecretResolver, secretManagerResolver } from './deliveries/secrets.js';
import { runDispatcher } from './dispatcher/loop.js';
import { loadWorkersEnv } from './env.js';
import { handleShopifyEvent } from './intents/consumer.js';
import { runReconcile } from './reconcile/index.js';
import { handleEngineEvent } from './results/consumer.js';
import { gcsRecordingStore, memoryRecordingStore } from './results/recordings.js';
import { shopifyWriteback } from './results/shopify-writeback.js';
import { recordingWriteback } from './results/writeback.js';
import { runWritebacks } from './writebacks/index.js';

const env = loadWorkersEnv();
const log = createLogger({
  service: `workers:${env.WORKER}`,
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});

const app = createDb({ url: env.DATABASE_URL, applicationName: `naaradh-workers-${env.WORKER}` });
const service = createServiceDb({
  url: env.DATABASE_SERVICE_URL,
  applicationName: `naaradh-workers-${env.WORKER}-svc`,
});
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
const registry = new EngineRegistry({ env });

const baseSecrets =
  env.NODE_ENV === 'production' ? secretManagerResolver() : inlineSecretResolver();
// `shopify-session:` refs decrypt from shopify_sessions and refresh expiring tokens (ADR-0007).
const secretsResolver =
  env.SHOPIFY_TOKEN_KEY !== undefined &&
  env.SHOPIFY_API_KEY !== undefined &&
  env.SHOPIFY_API_SECRET !== undefined
    ? shopifyTokenResolver(baseSecrets, {
        service: service.db,
        keys: new Map([[env.SHOPIFY_TOKEN_KID, parseSecretKey(env.SHOPIFY_TOKEN_KEY)]]),
        currentKid: env.SHOPIFY_TOKEN_KID,
        clientId: env.SHOPIFY_API_KEY,
        clientSecret: env.SHOPIFY_API_SECRET,
        now: () => systemClock.now(),
      })
    : baseSecrets;

const ctx: WorkerContext = {
  app: app.db,
  service: service.db,
  redis,
  registry,
  log,
  clock: systemClock,
  keys: {
    hashKey: env.PHONE_HASH_KEY,
    encPublicKeyPem: env.PHONE_ENC_PUBLIC_KEY,
    encKid: env.PHONE_ENC_KID,
    privateKeyPem: env.PHONE_ENC_PRIVATE_KEY ?? null,
  },
  gate: {
    engines: {
      defaultIn: env.ENGINE_DEFAULT_IN,
      defaultUs: env.ENGINE_DEFAULT_US,
      secondaryIn: env.ENGINE_SECONDARY_IN ?? null,
      secondaryUs: env.ENGINE_SECONDARY_US ?? null,
      maxConcurrency: {
        [env.ENGINE_DEFAULT_IN]: env.ENGINE_MAX_CONCURRENCY,
        [env.ENGINE_DEFAULT_US]: env.ENGINE_MAX_CONCURRENCY,
      },
    },
    engineDailyCapPaise: {
      [env.ENGINE_DEFAULT_IN]: env.ENGINE_DAILY_CAP_PAISE,
      [env.ENGINE_DEFAULT_US]: env.ENGINE_DAILY_CAP_PAISE,
    },
    globalDailyCapPaise: env.GLOBAL_DAILY_CAP_PAISE,
  },
  hooksBaseUrl: env.HOOKS_BASE_URL,
  voiceBaseUrl: env.VOICE_BASE_URL,
  engineWebhookKey: env.ENGINE_WEBHOOK_KEY,
  recordings:
    env.RECORDINGS_BUCKET === undefined
      ? memoryRecordingStore()
      : gcsRecordingStore(env.RECORDINGS_BUCKET),
  shopifyAdmin: { apiVersion: env.SHOPIFY_ADMIN_API_VERSION },
  razorpay:
    env.RAZORPAY_KEY_ID !== undefined && env.RAZORPAY_KEY_SECRET !== undefined
      ? createRazorpayClient({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET })
      : null,
  shopify:
    (env.SHOPIFY_WRITEBACK ?? (env.NODE_ENV === 'production' ? 'live' : 'recording')) === 'live'
      ? shopifyWriteback({ secrets: secretsResolver, apiVersion: env.SHOPIFY_ADMIN_API_VERSION })
      : recordingWriteback(),
  secrets: secretsResolver,
  mailer:
    env.POSTMARK_TOKEN === undefined
      ? memoryMailer()
      : postmarkMailer({ serverToken: env.POSTMARK_TOKEN, from: env.MAIL_FROM }),
  dashboardUrl: env.DASHBOARD_URL,
  workerId: `${env.WORKER}@${hostname()}#${String(process.pid)}`,
  dispatchBatch: env.DISPATCH_BATCH,
};

const controller = new AbortController();
const stops: (() => Promise<void>)[] = [];
const runs: Promise<void>[] = [];

const bus = createPubSubBus(
  env.GCP_PROJECT,
  env.PUBSUB_TOPIC_PREFIX,
  log,
  env.PUBSUB_EMULATOR_HOST !== undefined,
);
const role = env.WORKER;

if (role === 'intents' || role === 'all')
  stops.push(await bus.subscribe('shopify.events', 'intents', (m) => handleShopifyEvent(ctx, m)));
if (role === 'results' || role === 'all')
  stops.push(await bus.subscribe('engine.events', 'results', (m) => handleEngineEvent(ctx, m)));
if (role === 'dispatcher' || role === 'all')
  runs.push(runDispatcher(ctx, env.DISPATCH_POLL_MS, controller.signal));
if (role === 'reconcile' || role === 'all')
  runs.push(runReconcile(ctx, env.RECONCILE_INTERVAL_MS, controller.signal));
if (role === 'deliveries' || role === 'all')
  runs.push(runDeliveries(ctx, 5_000, controller.signal));
if (role === 'actions' || role === 'all') runs.push(runActions(ctx, 2_000, controller.signal));
if (role === 'writebacks' || role === 'all')
  runs.push(runWritebacks(ctx, 2_000, controller.signal));
if (role === 'billing' || role === 'all') {
  runs.push(runBilling(ctx, 30_000, controller.signal));
  stops.push(await bus.subscribe('billing.events', 'billing', (m) => handleBillingEvent(ctx, m)));
}
if (role === 'complaints' || role === 'all')
  runs.push(runComplaints(ctx, 5_000, controller.signal));
if (role === 'retention' || role === 'all') runs.push(runRetention(ctx, 60_000, controller.signal));
if (role === 'notifications' || role === 'all')
  runs.push(runNotifications(ctx, 30_000, controller.signal));

const health =
  env.PORT === undefined ? null : startHealthServer({ port: env.PORT, db: app.db, redis });

log.info({ role, worker_id: ctx.workerId, engine_in: env.ENGINE_DEFAULT_IN }, 'workers up');

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  controller.abort();
  health?.close();
  await Promise.all(stops.map((s) => s()));
  await Promise.allSettled(runs);
  await bus.close();
  await app.close();
  await service.close();
  redis.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
