import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { pingDb } from '@naaradh/db';
import { fastifyLoggerOptions, trustProxyOf } from '@naaradh/shared';
import type { VoiceDeps } from './context.js';
import { registerInboundRoutes } from './inbound.js';
import { registerToolRoutes } from './tools/route.js';

/**
 * voice.naaradh.com (ADR-0006, SPEC §6.3) — the synchronous half of a two-way call:
 *
 *   POST /inbound/:vendor                     who answers this call, and with what   (< 500 ms p95)
 *   POST /tools/:vendor/:tenantTag/:tool      one mid-call tool invocation            (< 700 ms p95)
 *
 * Unlike hooks, this service DECIDES — but only through packages/compliance (admitInbound,
 * the tool policies). Call events still flow engine → hooks → results-consumer.
 */
export async function buildServer(deps: VoiceDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: fastifyLoggerOptions(deps.logLevel ?? process.env['LOG_LEVEL'] ?? 'info'),
    trustProxy: trustProxyOf(deps.trustProxyHops),
    bodyLimit: 262_144, // 256 KiB — context and tool payloads are tiny
    requestIdHeader: 'x-cloud-trace-context',
    // An engine waits on us mid-conversation; a slow request is worse than a failed one.
    requestTimeout: 5_000,
  });

  // Signatures are over the exact bytes (invariant 9): keep them, parse in the adapter.
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
    let redis = false;
    try {
      await deps.redis.ping();
      redis = true;
    } catch {
      redis = false;
    }
    const ready = db && redis;
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? 'ok' : 'degraded', checks: { db, redis } });
  });

  registerInboundRoutes(app, deps);
  registerToolRoutes(app, deps);
  return app;
}
