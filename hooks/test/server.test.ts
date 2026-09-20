import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb } from '@naaradh/db';
import { EngineRegistry } from '@naaradh/engines-registry';
import { buildServer } from '../src/server.js';
import { memoryPublisher } from '../src/pubsub.js';

/**
 * Unit-level: no database is reachable (the URL points at a closed port), so only routes that
 * never touch it are exercised here. The webhook paths are covered by test/int/hooks.test.ts.
 */
describe('hooks server', () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const conn = createDb({ url: 'postgres://nobody:nobody@127.0.0.1:1/none', max: 1 });
    close = conn.close;
    app = await buildServer({
      db: conn.db,
      publisher: memoryPublisher(),
      registry: new EngineRegistry({
        env: {
          ENGINE_DEFAULT_IN: 'simulator',
          ENGINE_DEFAULT_US: 'simulator',
          SIMULATOR_WEBHOOK_SECRET: 'x'.repeat(16),
        },
      }),
      shopifySecretFor: () => 'secret',
      engineWebhookKey: 'k'.repeat(32),
      rateLimitPerMinute: 600,
      logLevel: 'silent',
    });
    app.post('/test/echo-raw', (request) => ({
      isBuffer: Buffer.isBuffer(request.body),
      bytes: Buffer.isBuffer(request.body) ? request.body.toString('utf8') : null,
    }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  it('answers liveness probes', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
  });

  it('reports not-ready when the database is unreachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
  });

  it('hands handlers the exact bytes the sender signed', async () => {
    // Invariant 9: HMAC is computed over the raw body. Key order and spacing below are
    // deliberately odd — if Fastify parsed and re-serialised this, the bytes would differ
    // and every signature check would silently fail.
    const raw = '{"b":2,  "a":1}';
    const response = await app.inject({
      method: 'POST',
      url: '/test/echo-raw',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ isBuffer: true, bytes: raw });
  });

  it('404s an engine URL whose tenant tag does not verify — no oracle', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/engine/simulator/ten_01AAAAAAAAAAAAAAAAAAAAAAAA.deadbeefdeadbeefdeadbeefdeadbeef',
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(404);
    const unknownVendor = await app.inject({
      method: 'POST',
      url: '/engine/nope/x.y',
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(unknownVendor.statusCode).toBe(404);
  });
});
