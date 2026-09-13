import type { FastifyInstance } from 'fastify';
import { and, eq, gt } from 'drizzle-orm';
import { schema, withTenant, type Db } from '@naaradh/db';
import { NaaradhError, addMinutes, sha256Hex } from '@naaradh/shared';

/**
 * `Idempotency-Key` (AGENTS §8): honoured for 24 h per tenant. A replay with the same key and
 * the same request returns the ORIGINAL response, status and all; the same key with a
 * different body is a 422 (the client has a bug and should know).
 */
export function registerIdempotency(app: FastifyInstance, db: Db, clock: () => Date): void {
  app.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'POST' || request.auth === undefined) return;
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) return;
    if (key.length > 200) throw new NaaradhError('VALIDATION_FAILED', 'Idempotency-Key too long');

    const requestHash = sha256Hex(
      `${request.method} ${request.url} ${JSON.stringify(request.body ?? null)}`,
    );
    const tenantId = request.auth.tenantId;
    const now = clock();
    const existing = await withTenant(db, tenantId, async (tx) => {
      const [row] = await tx
        .select({
          requestHash: schema.idempotencyKeys.requestHash,
          status: schema.idempotencyKeys.responseStatus,
          body: schema.idempotencyKeys.responseBody,
        })
        .from(schema.idempotencyKeys)
        .where(
          and(
            eq(schema.idempotencyKeys.tenantId, tenantId),
            eq(schema.idempotencyKeys.key, key),
            gt(schema.idempotencyKeys.expiresAt, now),
          ),
        )
        .limit(1);
      return row ?? null;
    });
    if (existing !== null) {
      if (existing.requestHash !== requestHash)
        throw new NaaradhError(
          'VALIDATION_FAILED',
          'Idempotency-Key was already used with a different request',
        );
      void reply.header('idempotent-replay', 'true');
      return reply.code(existing.status).send(existing.body);
    }
    request.idempotency = { key, requestHash, tenantId };
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const idem = request.idempotency;
    if (idem === undefined || reply.statusCode >= 500) return payload;
    let body: unknown = null;
    try {
      body = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch {
      body = payload;
    }
    const now = clock();
    await withTenant(db, idem.tenantId, (tx) =>
      tx
        .insert(schema.idempotencyKeys)
        .values({
          tenantId: idem.tenantId,
          key: idem.key,
          requestHash: idem.requestHash,
          responseStatus: reply.statusCode,
          responseBody: body,
          expiresAt: addMinutes(now, 24 * 60),
        })
        .onConflictDoNothing(),
    );
    return payload;
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: { key: string; requestHash: string; tenantId: string };
  }
  interface FastifyContextConfig {
    public?: boolean;
    rateLimit?: false | { max: number; timeWindow: string };
  }
}
