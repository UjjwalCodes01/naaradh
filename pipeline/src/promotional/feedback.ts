import { and, eq, isNull } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import type { PhoneRegion } from '@naaradh/shared';
import type { PhoneKeys } from '../contacts.js';
import { createIntent, type CreateIntentResult } from '../intents.js';

/**
 * Post-delivery feedback (ADR-0010 §7, P4-CMP-2) — a PROMOTIONAL use case (invariant 5), so the
 * gate still requires a live consent, a DND scrub, the DLT link and a registered template. This
 * only decides whether a delivered order deserves a feedback call at all.
 */

/** Statuses after which asking "how was your order?" would be tone-deaf or wrong (E-114). */
const NO_FEEDBACK_FINANCIAL = new Set(['refunded', 'voided', 'partially_refunded']);
const NO_FEEDBACK_FULFILMENT = new Set(['returned', 'failure', 'restocked']);

export type FeedbackResult =
  | CreateIntentResult
  | {
      status: 'skipped';
      reason:
        | 'order_not_cached'
        | 'order_cancelled'
        | 'order_refunded'
        | 'order_returned'
        | 'test_order'
        | 'no_contact'
        | 'not_delivered';
    };

export async function createFeedbackIntent(
  tx: DbOrTx,
  keys: PhoneKeys,
  input: {
    readonly tenantId: string;
    readonly source: 'shopify';
    readonly externalOrderId: string;
    readonly shipmentStatus: string | null;
    readonly deliveredAt: Date;
    readonly now: Date;
  },
): Promise<FeedbackResult> {
  if (input.shipmentStatus !== 'delivered') return { status: 'skipped', reason: 'not_delivered' };
  const [order] = await tx
    .select()
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.tenantId, input.tenantId),
        eq(schema.orders.source, input.source),
        eq(schema.orders.externalId, input.externalOrderId),
        isNull(schema.orders.erasedAt),
      ),
    )
    .limit(1);
  if (order === undefined) return { status: 'skipped', reason: 'order_not_cached' };
  if (order.isTest) return { status: 'skipped', reason: 'test_order' };
  if (order.cancelledAt !== null) return { status: 'skipped', reason: 'order_cancelled' };
  if (order.financialStatus !== null && NO_FEEDBACK_FINANCIAL.has(order.financialStatus))
    return { status: 'skipped', reason: 'order_refunded' };
  if (order.fulfillmentStatus !== null && NO_FEEDBACK_FULFILMENT.has(order.fulfillmentStatus))
    return { status: 'skipped', reason: 'order_returned' };
  if (order.phoneHash === null) return { status: 'skipped', reason: 'no_contact' };

  const [contact] = await tx
    .select({
      id: schema.contacts.id,
      region: schema.contacts.region,
      name: schema.contacts.name,
      erasedAt: schema.contacts.erasedAt,
    })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.tenantId, input.tenantId),
        eq(schema.contacts.phoneHash, order.phoneHash),
      ),
    )
    .limit(1);
  if (contact === undefined) return { status: 'skipped', reason: 'no_contact' };

  const [tenant] = await tx
    .select({ name: schema.tenants.name })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, input.tenantId))
    .limit(1);

  return createIntent(tx, keys, {
    tenantId: input.tenantId,
    useCase: 'feedback',
    source: 'shopify',
    account: 'delivery',
    // Idempotency is (source, account, order, use case): a second `delivered` event is a duplicate (E-115).
    externalRef: order.externalId,
    eventTs: input.deliveredAt,
    rawPhone: null,
    defaultRegion: contact.region as PhoneRegion,
    existingContact: {
      contactId: contact.id,
      phoneHash: order.phoneHash,
      region: contact.region,
      erased: contact.erasedAt !== null,
    },
    variables: {
      customer_name: contact.name ?? '',
      brand: tenant?.name ?? '',
      order_ref: order.name,
      item_summary: order.itemSummary,
    },
    valuePaise: order.totalMinor,
    currency: order.currency,
    now: input.now,
    actor: { type: 'shopify' },
  });
}
