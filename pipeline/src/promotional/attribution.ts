import { and, desc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import {
  ATTRIBUTION_WINDOW_HOURS_DEFAULT,
  ATTRIBUTION_WINDOW_HOURS_MAX,
} from '@naaradh/compliance';
import { addMinutes, newId } from '@naaradh/shared';
import { audit } from '../audit.js';
import { emitMerchantEvent } from '../outbox.js';

/**
 * Recovery attribution (ADR-0010 §9, P4-BILL-1 proposed). An order is credited to the most
 * recent abandoned-cart call that REACHED A HUMAN and ended before the order, within the use
 * case's window (default 24 h). Last touch, one per order. Measured for the ROI page and the
 * merchant; never billed — invariant 11's billable set is unchanged.
 */

export interface AttributeOrderInput {
  readonly tenantId: string;
  /** `orders.id` (the cache row). */
  readonly orderId: string;
  readonly phoneHash: string | null;
  readonly checkoutToken: string | null;
  readonly placedAt: Date;
  readonly valueMinor: number;
  readonly currency: string;
  readonly isTest: boolean;
  readonly now: Date;
}

/** Window from the tenant's settings (`attribution_hours`), clamped to 1…72 h. */
export async function attributionWindowHours(tx: DbOrTx, tenantId: string): Promise<number> {
  const [t] = await tx
    .select({ settings: schema.tenants.settings })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  const raw = (t?.settings as { attribution_hours?: unknown } | undefined)?.attribution_hours;
  const n =
    typeof raw === 'number' && Number.isInteger(raw) ? raw : ATTRIBUTION_WINDOW_HOURS_DEFAULT;
  return Math.min(Math.max(n, 1), ATTRIBUTION_WINDOW_HOURS_MAX);
}

export type AttributionResult =
  | { readonly attributed: false; readonly reason: string }
  | {
      readonly attributed: true;
      readonly attributionId: string;
      readonly matchedBy: 'checkout' | 'phone';
    };

export async function attributeOrder(
  tx: DbOrTx,
  input: AttributeOrderInput,
): Promise<AttributionResult> {
  if (input.isTest) return { attributed: false, reason: 'test_order' };
  if (input.phoneHash === null && input.checkoutToken === null)
    return { attributed: false, reason: 'no_match_key' };
  const windowHours = await attributionWindowHours(tx, input.tenantId);
  const since = addMinutes(input.placedAt, -windowHours * 60);

  const byCheckout =
    input.checkoutToken === null
      ? sql`false`
      : sql`${input.checkoutToken} = any(${schema.callIntents.externalRefs})`;
  const byPhone =
    input.phoneHash === null ? sql`false` : eq(schema.callAttempts.phoneHash, input.phoneHash);
  const [call] = await tx
    .select({
      attemptId: schema.callAttempts.id,
      intentId: schema.callAttempts.intentId,
      endedAt: schema.callAttempts.endedAt,
      outcomeId: schema.callOutcomes.id,
      checkoutMatch: sql<boolean>`${byCheckout}`,
    })
    .from(schema.callAttempts)
    .innerJoin(schema.callIntents, eq(schema.callIntents.id, schema.callAttempts.intentId))
    .leftJoin(schema.callOutcomes, eq(schema.callOutcomes.attemptId, schema.callAttempts.id))
    .where(
      and(
        eq(schema.callAttempts.tenantId, input.tenantId),
        eq(schema.callIntents.useCase, 'abandoned_cart'),
        eq(schema.callAttempts.direction, 'outbound'),
        // E-117: only a call a person answered can have caused anything.
        eq(schema.callAttempts.answeredBy, 'human'),
        isNotNull(schema.callAttempts.endedAt),
        lte(schema.callAttempts.endedAt, input.placedAt),
        gte(schema.callAttempts.endedAt, since),
        sql`(${byCheckout} or ${byPhone})`,
      ),
    )
    .orderBy(desc(schema.callAttempts.endedAt))
    .limit(1);
  if (call === undefined || call.intentId === null || call.endedAt === null)
    return { attributed: false, reason: 'no_qualifying_call' };

  const id = newId('attribution');
  const matchedBy = call.checkoutMatch ? 'checkout' : 'phone';
  const inserted = await tx
    .insert(schema.attributions)
    .values({
      id,
      tenantId: input.tenantId,
      useCase: 'abandoned_cart',
      orderId: input.orderId,
      intentId: call.intentId,
      attemptId: call.attemptId,
      outcomeId: call.outcomeId,
      matchedBy,
      valueMinor: Math.max(0, input.valueMinor),
      currency: input.currency,
      windowHours,
      callEndedAt: call.endedAt,
      orderPlacedAt: input.placedAt,
    })
    .onConflictDoNothing({
      target: [
        schema.attributions.tenantId,
        schema.attributions.orderId,
        schema.attributions.useCase,
      ],
    })
    .returning({ id: schema.attributions.id });
  if (inserted[0] === undefined) return { attributed: false, reason: 'already_attributed' };

  await audit(tx, {
    tenantId: input.tenantId,
    actorType: 'worker',
    action: 'order.recovered',
    targetType: 'order',
    targetId: input.orderId,
    after: { attempt_id: call.attemptId, matched_by: matchedBy, window_hours: windowHours },
  });
  await emitMerchantEvent(tx, input.tenantId, {
    type: 'order.recovered',
    eventId: `${id}:recovered`,
    at: input.now,
    data: {
      attribution_id: id,
      order_id: input.orderId,
      intent_id: call.intentId,
      attempt_id: call.attemptId,
      matched_by: matchedBy,
      value_minor: input.valueMinor,
      currency: input.currency,
      billable: false,
    },
  });
  return { attributed: true, attributionId: id, matchedBy };
}

/** E-118: a cancelled order is no longer a recovery. Idempotent. */
export async function reverseAttribution(
  tx: DbOrTx,
  input: { readonly tenantId: string; readonly orderId: string; readonly at: Date },
): Promise<number> {
  const rows = await tx
    .update(schema.attributions)
    .set({ reversedAt: input.at })
    .where(
      and(
        eq(schema.attributions.tenantId, input.tenantId),
        eq(schema.attributions.orderId, input.orderId),
        isNull(schema.attributions.reversedAt),
      ),
    )
    .returning({ id: schema.attributions.id });
  for (const r of rows)
    await audit(tx, {
      tenantId: input.tenantId,
      actorType: 'worker',
      action: 'attribution.reversed',
      targetType: 'attribution',
      targetId: r.id,
    });
  return rows.length;
}
