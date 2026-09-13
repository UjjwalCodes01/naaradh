import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withTenant, type Db } from '@naaradh/db';
import { MERCHANT_EVENTS, audit } from '@naaradh/pipeline';
import { NaaradhError, newId } from '@naaradh/shared';
import { requireScope } from '../auth.js';
import type { SecretStore } from '../secrets.js';

/**
 * Merchant webhook registry (AGENTS §8): POST/GET/DELETE /v1/webhooks. The signing secret is
 * returned exactly once, at creation, and stored only as a secret reference.
 */
const CreateWebhookBody = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), 'must be https'),
  events: z.array(z.enum(MERCHANT_EVENTS)).min(1),
});

export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: { db: Db; secrets: SecretStore; clock: () => Date },
): void {
  app.post('/v1/webhooks', async (request, reply) => {
    const auth = requireScope(request, 'webhooks:write');
    const body = CreateWebhookBody.parse(request.body);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const id = newId('merchantWebhook');
    const secretRef = await deps.secrets.put(`merchant-webhook-${id}`, secret);
    await withTenant(deps.db, auth.tenantId, async (tx) => {
      const [count] = await tx
        .select({ id: schema.merchantWebhooks.id })
        .from(schema.merchantWebhooks)
        .where(
          and(
            eq(schema.merchantWebhooks.tenantId, auth.tenantId),
            eq(schema.merchantWebhooks.active, true),
          ),
        );
      void count;
      await tx.insert(schema.merchantWebhooks).values({
        id,
        tenantId: auth.tenantId,
        url: body.url,
        secretRef,
        events: body.events,
        active: true,
      });
      await audit(tx, {
        tenantId: auth.tenantId,
        actorType: 'api_key',
        actorId: auth.apiKeyId,
        action: 'webhook.created',
        targetType: 'merchant_webhook',
        targetId: id,
        after: { url: body.url, events: body.events },
      });
    });
    return reply.code(201).send({
      webhook_id: id,
      url: body.url,
      events: body.events,
      secret,
      note: 'store the secret now; it is not retrievable later',
    });
  });

  app.get('/v1/webhooks', async (request) => {
    const auth = requireScope(request, 'webhooks:read');
    const rows = await withTenant(deps.db, auth.tenantId, (tx) =>
      tx
        .select({
          id: schema.merchantWebhooks.id,
          url: schema.merchantWebhooks.url,
          events: schema.merchantWebhooks.events,
          active: schema.merchantWebhooks.active,
          consecutiveFailures: schema.merchantWebhooks.consecutiveFailures,
          disabledReason: schema.merchantWebhooks.disabledReason,
          createdAt: schema.merchantWebhooks.createdAt,
        })
        .from(schema.merchantWebhooks)
        .where(eq(schema.merchantWebhooks.tenantId, auth.tenantId))
        .orderBy(desc(schema.merchantWebhooks.createdAt)),
    );
    return {
      webhooks: rows.map((r) => ({
        webhook_id: r.id,
        url: r.url,
        events: r.events,
        active: r.active,
        consecutive_failures: r.consecutiveFailures,
        disabled_reason: r.disabledReason,
        created_at: r.createdAt.toISOString(),
      })),
    };
  });

  app.delete<{ Params: { id: string } }>('/v1/webhooks/:id', async (request, reply) => {
    const auth = requireScope(request, 'webhooks:write');
    const now = deps.clock();
    const removed = await withTenant(deps.db, auth.tenantId, async (tx) => {
      const rows = await tx
        .update(schema.merchantWebhooks)
        .set({ active: false, disabledAt: now, disabledReason: 'deleted via api' })
        .where(
          and(
            eq(schema.merchantWebhooks.tenantId, auth.tenantId),
            eq(schema.merchantWebhooks.id, request.params.id),
            eq(schema.merchantWebhooks.active, true),
          ),
        )
        .returning({ id: schema.merchantWebhooks.id });
      if (rows.length === 1)
        await audit(tx, {
          tenantId: auth.tenantId,
          actorType: 'api_key',
          actorId: auth.apiKeyId,
          action: 'webhook.deleted',
          targetType: 'merchant_webhook',
          targetId: request.params.id,
        });
      return rows.length === 1;
    });
    if (!removed) throw new NaaradhError('NOT_FOUND', 'webhook not found');
    return reply.code(204).send();
  });

  app.get('/v1/webhooks/deliveries', async (request) => {
    const auth = requireScope(request, 'webhooks:read');
    const rows = await withTenant(deps.db, auth.tenantId, (tx) =>
      tx
        .select({
          id: schema.merchantWebhookDeliveries.id,
          webhookId: schema.merchantWebhookDeliveries.webhookId,
          eventType: schema.merchantWebhookDeliveries.eventType,
          eventId: schema.merchantWebhookDeliveries.eventId,
          status: schema.merchantWebhookDeliveries.status,
          attempts: schema.merchantWebhookDeliveries.attempts,
          lastStatusCode: schema.merchantWebhookDeliveries.lastStatusCode,
          lastError: schema.merchantWebhookDeliveries.lastError,
          nextAttemptAt: schema.merchantWebhookDeliveries.nextAttemptAt,
          createdAt: schema.merchantWebhookDeliveries.createdAt,
        })
        .from(schema.merchantWebhookDeliveries)
        .where(eq(schema.merchantWebhookDeliveries.tenantId, auth.tenantId))
        .orderBy(desc(schema.merchantWebhookDeliveries.createdAt))
        .limit(100),
    );
    return {
      deliveries: rows.map((r) => ({
        ...r,
        nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}
