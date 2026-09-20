import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@naaradh/db';
import { parseRazorpaySubscriptionEvent, verifyRazorpaySignature } from '@naaradh/payments';
import { sha256Hex } from '@naaradh/shared';
import { markFailed, markProcessed, markPublished, recordWebhook } from '../events.js';
import type { Publisher } from '../pubsub.js';

/**
 * POST /razorpay/webhooks — subscription lifecycle for direct Indian merchants (P2-BILL-3).
 * Same four steps as every hook: verify (X-Razorpay-Signature, HMAC-SHA256 of the raw body,
 * invariant 9) → dedupe (x-razorpay-event-id) → publish to `billing.events` → 200.
 *
 * Only the NORMALISED subscription event is stored — Razorpay bodies can carry the payer's
 * email and phone in the payment entity, and nothing here needs them. The worker re-fetches the
 * subscription from Razorpay before changing anything (ADR-0008: webhooks are hints).
 */
export interface RazorpayRouteDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly webhookSecret: string | null;
}

export function registerRazorpayRoutes(app: FastifyInstance, deps: RazorpayRouteDeps): void {
  app.post('/razorpay/webhooks', async (request, reply) => {
    if (deps.webhookSecret === null) return reply.code(404).send({ error: 'not found' });
    const raw = request.body as Buffer;
    const signature = request.headers['x-razorpay-signature'];
    const eventId = request.headers['x-razorpay-event-id'];
    const externalEventId =
      typeof eventId === 'string' && eventId.length > 0 ? eventId : `sha256:${sha256Hex(raw)}`;
    const headers = {
      'content-type': request.headers['content-type'],
      'x-razorpay-event-id': typeof eventId === 'string' ? eventId : undefined,
    };

    if (
      !verifyRazorpaySignature(
        deps.webhookSecret,
        raw,
        typeof signature === 'string' ? signature : undefined,
      )
    ) {
      await recordWebhook(deps.db, {
        source: 'razorpay',
        externalEventId: `rejected:${externalEventId}`,
        topic: 'unknown',
        tenantId: null,
        externalAccount: null,
        signatureValid: false,
        payload: null,
        payloadSha256: sha256Hex(raw),
        headers,
      });
      request.log.warn('razorpay webhook rejected: bad signature');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const event = parseRazorpaySubscriptionEvent(raw);
    const [sub] =
      event === null
        ? []
        : await deps.db
            .select({ tenantId: schema.billingSubscriptions.tenantId })
            .from(schema.billingSubscriptions)
            .where(
              and(
                eq(schema.billingSubscriptions.provider, 'razorpay'),
                eq(schema.billingSubscriptions.providerSubscriptionId, event.subscriptionId),
              ),
            )
            .limit(1);
    const recorded = await recordWebhook(deps.db, {
      source: 'razorpay',
      externalEventId,
      topic: event?.event ?? 'other',
      tenantId: sub?.tenantId ?? null,
      externalAccount: event?.subscriptionId ?? null,
      signatureValid: true,
      payload:
        event === null
          ? { ignored: true }
          : { event: event.event, subscription_id: event.subscriptionId, status: event.status },
      payloadSha256: sha256Hex(raw),
      headers,
    });
    if (recorded.kind === 'duplicate')
      return reply.code(200).send({ status: 'duplicate', id: recorded.id });
    if (event === null || sub === undefined) {
      await markProcessed(
        deps.db,
        recorded.id,
        event === null ? 'not_a_subscription_event' : 'unknown_subscription',
      );
      return reply.code(200).send({ status: 'ignored', id: recorded.id });
    }
    // A subscription we created carries our tenant id in its notes; a mismatch is suspicious.
    if (event.tenantId !== null && event.tenantId !== sub.tenantId) {
      await markProcessed(deps.db, recorded.id, 'tenant_mismatch');
      request.log.error({ subscription: event.subscriptionId }, 'razorpay webhook tenant mismatch');
      return reply.code(200).send({ status: 'ignored', id: recorded.id });
    }
    try {
      const messageId = await deps.publisher.publish('billing.events', {
        webhook_event_id: recorded.id,
        source: 'razorpay',
        topic: event.event,
        tenant_id: sub.tenantId,
        external_account: event.subscriptionId,
        received_at: new Date().toISOString(),
      });
      await markPublished(deps.db, recorded.id, messageId);
      return await reply.code(200).send({ status: 'published', id: recorded.id });
    } catch (error) {
      await markFailed(
        deps.db,
        recorded.id,
        error instanceof Error ? error.message : String(error),
      );
      return reply.code(500).send({ status: 'publish_failed', id: recorded.id });
    }
  });
}
