import { and, eq, sql } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import { newId } from '@naaradh/shared';

/**
 * Merchant-facing events (AGENTS §8): intent.scheduled, intent.gated, call.started,
 * call.completed, outcome.final, suppression.created. Written as delivery rows in the same
 * transaction as the state change (transactional outbox), delivered by the webhook worker
 * with retries, dead-lettered after 5 and visible in the dashboard.
 *
 * Payloads are PII-minimised by construction: masked number only, never a name, never a
 * transcript. The merchant already has the order; we tell them what happened to it.
 */
export const MERCHANT_EVENTS = [
  'intent.scheduled',
  'intent.gated',
  'intent.cancelled',
  'call.started',
  'call.completed',
  'outcome.final',
  'suppression.created',
  // inbound (ADR-0006)
  'ticket.created',
  'ticket.resolved',
  'order.cancellation_requested',
  'order.cancelled_by_agent',
  'order.confirmed_by_caller',
  'inbound.call_refused',
  // compliance (Phase 2)
  'complaint.received',
  'tenant.paused',
  'erasure.completed',
  // billing (Phase 2)
  'billing.status_changed',
  'billing.capped',
  'billing.approaching_cap',
  // promotional (Phase 4, ADR-0010)
  'checkout.recovery_requested',
  'order.recovered',
  'promotional.paused',
  // appointments (Phase 5, ADR-0011)
  'appointment.booked',
] as const;
export type MerchantEventType = (typeof MERCHANT_EVENTS)[number];

export interface MerchantEvent {
  readonly type: MerchantEventType;
  /** Stable id so the merchant can dedupe; usually the intent/attempt/outcome id + type. */
  readonly eventId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly at: Date;
}

/**
 * Events that also email the account's owners and managers (P2-WEB-4) — the ones a merchant
 * must hear about even without a webhook endpoint, because calling stopped or money is involved.
 */
export const EMAIL_ALERT_EVENTS: ReadonlySet<MerchantEventType> = new Set([
  'complaint.received',
  'tenant.paused',
  'billing.capped',
  'billing.approaching_cap',
  'billing.status_changed',
  'erasure.completed',
  'promotional.paused',
]);

/**
 * Enqueue for every active endpoint subscribed to this event type, and queue the email alert
 * when the event is one merchants must hear about. Returns webhook deliveries created.
 */
export async function emitMerchantEvent(
  tx: DbOrTx,
  tenantId: string,
  event: MerchantEvent,
): Promise<number> {
  if (EMAIL_ALERT_EVENTS.has(event.type))
    await tx
      .insert(schema.merchantNotifications)
      .values({
        id: newId('notification'),
        tenantId,
        kind: event.type,
        eventId: event.eventId,
        data: event.data,
        status: 'pending',
        nextAttemptAt: event.at,
      })
      .onConflictDoNothing({
        target: [
          schema.merchantNotifications.tenantId,
          schema.merchantNotifications.kind,
          schema.merchantNotifications.eventId,
        ],
      });
  const endpoints = await tx
    .select({ id: schema.merchantWebhooks.id })
    .from(schema.merchantWebhooks)
    .where(
      and(
        eq(schema.merchantWebhooks.tenantId, tenantId),
        eq(schema.merchantWebhooks.active, true),
        sql`${event.type} = any(${schema.merchantWebhooks.events})`,
      ),
    );
  if (endpoints.length === 0) return 0;
  const payload = {
    id: event.eventId,
    type: event.type,
    created_at: event.at.toISOString(),
    data: event.data,
  };
  await tx
    .insert(schema.merchantWebhookDeliveries)
    .values(
      endpoints.map((e) => ({
        id: newId('delivery'),
        tenantId,
        webhookId: e.id,
        eventType: event.type,
        eventId: event.eventId,
        payload,
        status: 'pending' as const,
        nextAttemptAt: event.at,
      })),
    )
    .onConflictDoNothing({
      target: [
        schema.merchantWebhookDeliveries.webhookId,
        schema.merchantWebhookDeliveries.eventId,
      ],
    });
  return endpoints.length;
}
