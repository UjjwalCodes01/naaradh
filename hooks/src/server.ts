import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { pingDb, type Db } from '@naaradh/db';
import { fastifyLoggerOptions, trustProxyOf } from '@naaradh/shared';
import type { EngineRegistry } from '@naaradh/engines-registry';
import type { Publisher } from './pubsub.js';
import { registerEngineRoutes } from './routes/engine.js';
import { registerRazorpayRoutes } from './routes/razorpay.js';
import { registerStripeRoutes } from './routes/stripe.js';
import { registerRegionRoutes, type RegionDeps } from './routes/region.js';
import { registerShopifyRoutes } from './routes/shopify.js';

/**
 * hooks.naaradh.com — every inbound webhook: Shopify, engine vendors, later payments and
 * one-click-checkout providers.
 *
 * This service does exactly four things, in order: **verify the signature, dedupe, publish
 * to Pub/Sub, return 200** — under 800 ms at p99. No business logic lives here (AGENTS §3).
 * Anything slower or smarter belongs in a worker, because Shopify retries on timeout and
 * eventually removes the subscription.
 */
export interface HooksDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly registry: EngineRegistry;
  readonly shopifySecretFor: (shopDomain: string) => string;
  readonly engineWebhookKey: string;
  /** Null → the Razorpay route answers 404 (not configured in this environment). */
  readonly razorpayWebhookSecret?: string | null;
  /** Null → the Stripe route answers 404 (not configured in this environment). */
  readonly stripeWebhookSecret?: string | null;
  /** Tests walk the clock past Stripe's replay window. */
  readonly nowUnix?: () => number;
  /** DATA_REGION, peers and the directory sync key (ADR-0012 §4). Absent = single region. */
  readonly region?: Omit<RegionDeps, 'db'>;
  readonly rateLimitPerMinute: number;
  /** TRUST_PROXY_HOPS — trailing X-Forwarded-For entries that are ours (see @naaradh/shared baseEnv). */
  readonly trustProxyHops?: number;
  readonly logLevel?: string;
}

export async function buildServer(deps: HooksDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: fastifyLoggerOptions(deps.logLevel ?? process.env['LOG_LEVEL'] ?? 'info'),
    trustProxy: trustProxyOf(deps.trustProxyHops),
    bodyLimit: 1_048_576, // 1 MiB — webhook bodies are small; a cheap defence on a public endpoint
    requestIdHeader: 'x-cloud-trace-context',
  });

  /**
   * Keep the raw bytes.
   *
   * Every inbound webhook is verified by HMAC over the **exact** bytes the sender signed
   * (invariant 9). Fastify's default JSON parser throws those bytes away, and re-serialising
   * the parsed object does not reproduce them — key order, whitespace and unicode escaping
   * all differ, so the digest silently stops matching. Parse to Buffer; verify; only then
   * JSON.parse in the handler.
   */
  app.addContentTypeParser(
    ['application/json', 'application/x-www-form-urlencoded', 'text/plain'],
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  await app.register(rateLimit, {
    max: deps.rateLimitPerMinute,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1'],
  });

  app.get('/healthz', { config: { rateLimit: false } }, () => ({ status: 'ok' }));
  app.get('/readyz', { config: { rateLimit: false } }, async (_req, reply) => {
    const db = await pingDb(deps.db);
    return reply.code(db ? 200 : 503).send({ status: db ? 'ok' : 'degraded', checks: { db } });
  });

  registerShopifyRoutes(app, {
    db: deps.db,
    publisher: deps.publisher,
    secretForShop: deps.shopifySecretFor,
    ...(deps.region === undefined ? {} : { region: { ...deps.region, db: deps.db } }),
  });
  if (deps.region !== undefined) registerRegionRoutes(app, { ...deps.region, db: deps.db });
  registerEngineRoutes(app, {
    db: deps.db,
    publisher: deps.publisher,
    registry: deps.registry,
    webhookKey: deps.engineWebhookKey,
  });

  registerRazorpayRoutes(app, {
    db: deps.db,
    publisher: deps.publisher,
    webhookSecret: deps.razorpayWebhookSecret ?? null,
  });
  registerStripeRoutes(app, {
    db: deps.db,
    publisher: deps.publisher,
    webhookSecret: deps.stripeWebhookSecret ?? null,
    ...(deps.nowUnix === undefined ? {} : { nowUnix: deps.nowUnix }),
  });

  return app;
}
