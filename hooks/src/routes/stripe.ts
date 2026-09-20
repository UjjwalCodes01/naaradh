import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from '@naaradh/db';
import { parseStripeEvent, verifyStripeSignature } from '@naaradh/payments';
import { sha256Hex } from '@naaradh/shared';
import { markFailed, markProcessed, markPublished, recordWebhook } from '../events.js';
import type { Publisher } from '../pubsub.js';

/**
 * POST /stripe/webhooks — subscription lifecycle for dollar merchants (P6-BILL-1). Same four
 * steps as every hook: verify (Stripe-Signature, HMAC-SHA256 over `t.raw_body`, invariant 9) →
 * dedupe (the event id) → publish to `billing.events` → 200.
 *
 * Only ids are stored: a Stripe event body can carry the payer's name, email and billing
 * address, and nothing downstream needs them. The worker re-fetches the session or
 * subscription from Stripe before changing anything (ADR-0008: webhooks are hints).
 */
export interface StripeRouteDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly webhookSecret: string | null;
  readonly nowUnix?: () => number;
}

export function registerStripeRoutes(app: FastifyInstance, deps: StripeRouteDeps): void {
  app.post('/stripe/webhooks', async (request, reply) => {
    if (deps.webhookSecret === null) return reply.code(404).send({ error: 'not found' });
    const raw = request.body as Buffer;
    const signature = request.headers['stripe-signature'];
    const headers = { 'content-type': request.headers['content-type'] };
    const now = deps.nowUnix?.() ?? Math.floor(Date.now() / 1000);

    if (
      !verifyStripeSignature(
        deps.webhookSecret,
        raw,
        typeof signature === 'string' ? signature : undefined,
        now,
      )
    ) {
      await recordWebhook(deps.db, {
        source: 'stripe',
        externalEventId: `rejected:sha256:${sha256Hex(raw)}`,
        topic: 'unknown',
        tenantId: null,
        externalAccount: null,
        signatureValid: false,
        payload: null,
        payloadSha256: sha256Hex(raw),
        headers,
      });
      request.log.warn('stripe webhook rejected: bad signature');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const event = parseStripeEvent(raw);
    if (event === null) return reply.code(400).send({ error: 'unparseable' });
    // A pending row is keyed by the Checkout Session until Checkout completes, then by the
    // subscription: look for either.
    const keys = [event.subscriptionId, event.checkoutSessionId].filter(
      (k): k is string => k !== null,
    );
    const [sub] =
      keys.length === 0
        ? []
        : await deps.db
            .select({ tenantId: schema.billingSubscriptions.tenantId })
            .from(schema.billingSubscriptions)
            .where(
              and(
                eq(schema.billingSubscriptions.provider, 'stripe'),
                inArray(schema.billingSubscriptions.providerSubscriptionId, keys),
              ),
            )
            .limit(1);
    const recorded = await recordWebhook(deps.db, {
      source: 'stripe',
      externalEventId: event.id,
      topic: event.type,
      tenantId: sub?.tenantId ?? null,
      externalAccount: event.subscriptionId ?? event.checkoutSessionId,
      signatureValid: true,
      payload: {
        type: event.type,
        subscription_id: event.subscriptionId,
        checkout_session_id: event.checkoutSessionId,
      },
      payloadSha256: sha256Hex(raw),
      headers,
    });
    if (recorded.kind === 'duplicate')
      return reply.code(200).send({ status: 'duplicate', id: recorded.id });
    if (keys.length === 0 || sub === undefined) {
      await markProcessed(
        deps.db,
        recorded.id,
        keys.length === 0 ? 'not_a_subscription_event' : 'unknown_subscription',
      );
      return reply.code(200).send({ status: 'ignored', id: recorded.id });
    }
    try {
      const messageId = await deps.publisher.publish('billing.events', {
        webhook_event_id: recorded.id,
        source: 'stripe',
        topic: event.type,
        tenant_id: sub.tenantId,
        external_account: event.subscriptionId ?? event.checkoutSessionId ?? '',
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
