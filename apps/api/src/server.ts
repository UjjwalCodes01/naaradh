import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Redis } from 'ioredis';
import { pingDb, type Db } from '@naaradh/db';
import type { PhoneKeys } from '@naaradh/pipeline';
import { fastifyLoggerOptions } from '@naaradh/shared';
import { registerSnippetCors } from './cors.js';
import { registerAuth } from './auth.js';
import { errorHandler } from './errors.js';
import { registerIdempotency } from './idempotency.js';
import { registerCallRoutes, type Signer } from './routes/calls.js';
import { registerConsentRoutes } from './routes/consents.js';
import { registerIntentRoutes } from './routes/intents.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerPrivacyRoutes } from './routes/privacy.js';
import { registerSupportRoutes } from './routes/support.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import type { RazorpayClient } from '@naaradh/payments';
import type { SecretStore } from './secrets.js';

/**
 * api.naaradh.com — the public REST API (SPEC §9.1) for Client B and every non-Shopify
 * integration. Every route: API key → scope → Zod → withTenant(). The api never dials and
 * never reads a phone number back; it hands intents to the same pipeline Shopify uses.
 */
export interface ApiDeps {
  readonly db: Db;
  readonly redis: Redis;
  readonly keys: PhoneKeys;
  /** Staff key pair, public half: transfer targets and fallback lines (invariant 19). */
  readonly staffKey: { readonly publicKeyPem: string; readonly kid: number };
  readonly signer: Signer;
  /** Null when Razorpay is not configured (direct billing unavailable). */
  readonly razorpay?: RazorpayClient | null;
  readonly razorpayPlanIds?: Readonly<Record<string, string>>;
  readonly secrets: SecretStore;
  readonly clock: () => Date;
  readonly rateLimitKeyPerMinute: number;
  readonly rateLimitPublicPerMinute: number;
  readonly defaultDailyCap: number;
  readonly logLevel?: string;
}

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: fastifyLoggerOptions(deps.logLevel ?? process.env['LOG_LEVEL'] ?? 'info'),
    trustProxy: true,
    bodyLimit: 256 * 1024,
    requestIdHeader: 'x-cloud-trace-context',
  });
  app.setErrorHandler(errorHandler);

  await app.register(rateLimit, {
    global: true,
    max: (request) =>
      request.auth?.kind === 'public' ? deps.rateLimitPublicPerMinute : deps.rateLimitKeyPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (request) =>
      request.auth?.kind === 'public'
        ? `pk:${request.auth.apiKeyId}:${request.ip}`
        : (request.auth?.apiKeyId ?? request.ip),
    hook: 'preHandler', // after auth, so the key is the limit key
    errorResponseBuilder: (request, context) => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      error: 'Too Many Requests',
      message: `rate limit exceeded, retry in ${String(Math.ceil(context.ttl / 1000))}s`,
      request_id: request.id,
    }),
  });

  // `POST …/cancel` and `DELETE` have no body; a client that still sends
  // `content-type: application/json` must not get a 400 for an empty body.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (typeof body !== 'string' || body.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (error) {
      done(
        error instanceof Error
          ? Object.assign(error, { statusCode: 400 })
          : new Error('invalid JSON'),
        undefined,
      );
    }
  });

  registerAuth(app, { db: deps.db, redis: deps.redis, defaultDailyCap: deps.defaultDailyCap });
  registerSnippetCors(app);
  registerIdempotency(app, deps.db, deps.clock);

  app.get('/healthz', { config: { public: true, rateLimit: false } }, () => ({ status: 'ok' }));
  app.get('/readyz', { config: { public: true, rateLimit: false } }, async (_req, reply) => {
    const db = await pingDb(deps.db);
    return reply.code(db ? 200 : 503).send({ status: db ? 'ok' : 'degraded', checks: { db } });
  });

  registerIntentRoutes(app, { db: deps.db, redis: deps.redis, keys: deps.keys, clock: deps.clock });
  registerConsentRoutes(app, { db: deps.db, keys: deps.keys, clock: deps.clock });
  registerCallRoutes(app, { db: deps.db, signer: deps.signer, clock: deps.clock });
  registerWebhookRoutes(app, { db: deps.db, secrets: deps.secrets, clock: deps.clock });
  registerBillingRoutes(app, {
    db: deps.db,
    razorpay: deps.razorpay ?? null,
    razorpayPlanIds: deps.razorpayPlanIds ?? {},
    clock: deps.clock,
  });
  registerPrivacyRoutes(app, {
    db: deps.db,
    redis: deps.redis,
    keys: deps.keys,
    clock: deps.clock,
  });
  registerSupportRoutes(app, {
    db: deps.db,
    keys: deps.keys,
    staffKey: deps.staffKey,
    clock: deps.clock,
  });

  return app;
}
