import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import { normalisePincode, orderNameKey } from '@naaradh/compliance';
import { hashPhone, newId, normalizePhone, type PhoneRegion } from '@naaradh/shared';

/**
 * The order cache (ADR-0006) — what the voice agent can say about a caller's orders, and the
 * two hashes that decide whether it may say it:
 *
 *   phone_hash    HMAC(PHONE_HASH_KEY, e164)            → caller_id identity
 *   pincode_hash  HMAC(PHONE_HASH_KEY, 'pincode:' + pin) → knowledge identity (with the order number)
 *
 * No names, no addresses, no line-level PII: only what a status answer needs.
 */

export type OrderSource = (typeof schema.orderSource.enumValues)[number];
export type PaymentKind = (typeof schema.paymentKind.enumValues)[number];

export interface Tracking {
  readonly company: string | null;
  readonly number: string | null;
  readonly url: string | null;
  readonly status: string | null;
  readonly estimatedDelivery: string | null;
}

export interface OrderUpsert {
  readonly tenantId: string;
  readonly source: OrderSource;
  readonly externalId: string;
  readonly name: string;
  readonly rawPhone: string | null;
  /** Interprets a phone number with no country code (the store's country). */
  readonly defaultRegion: PhoneRegion;
  readonly pincode: string | null;
  readonly paymentKind: PaymentKind;
  readonly financialStatus: string | null;
  readonly fulfillmentStatus: string | null;
  readonly cancelledAt: Date | null;
  readonly totalMinor: number;
  readonly currency: string;
  readonly itemSummary: string;
  readonly itemCount: number;
  readonly placedAt: Date;
  /** Source-side updated_at: an older webhook arriving late never overwrites a newer one. */
  readonly sourceUpdatedAt: Date | null;
  readonly tracking?: Tracking | null;
}

export function hashPincode(hashKey: string, pincode: string): string {
  return createHmac('sha256', hashKey)
    .update(`pincode:${normalisePincode(pincode)}`)
    .digest('hex');
}

/** Constant-time comparison of a spoken pincode against the stored hash (E-94). */
export function pincodeMatches(hashKey: string, spoken: string, stored: string | null): boolean {
  const candidate = Buffer.from(hashPincode(hashKey, spoken), 'hex');
  // Compare against a dummy when there is nothing stored, so timing does not reveal existence.
  const target = Buffer.from(stored ?? '0'.repeat(64), 'hex');
  return (
    candidate.length === target.length && timingSafeEqual(candidate, target) && stored !== null
  );
}

export async function upsertOrder(
  tx: DbOrTx,
  hashKey: string,
  input: OrderUpsert,
): Promise<{ id: string; applied: boolean }> {
  let phoneHash: string | null = null;
  if (input.rawPhone !== null && input.rawPhone.trim().length > 0) {
    const parsed = normalizePhone(input.rawPhone, input.defaultRegion);
    if (parsed.ok) phoneHash = hashPhone(parsed.phone.e164, hashKey);
  }
  const pincodeHash =
    input.pincode === null || input.pincode.trim().length === 0
      ? null
      : hashPincode(hashKey, input.pincode);
  const values = {
    tenantId: input.tenantId,
    source: input.source,
    externalId: input.externalId,
    name: input.name.slice(0, 80),
    nameKey: orderNameKey(input.name) || orderNameKey(input.externalId),
    phoneHash,
    pincodeHash,
    paymentKind: input.paymentKind,
    financialStatus: input.financialStatus,
    fulfillmentStatus: input.fulfillmentStatus,
    cancelledAt: input.cancelledAt,
    totalMinor: input.totalMinor,
    currency: input.currency,
    itemSummary: input.itemSummary.slice(0, 200),
    itemCount: input.itemCount,
    placedAt: input.placedAt,
    sourceUpdatedAt: input.sourceUpdatedAt,
    ...(input.tracking === undefined ? {} : { tracking: input.tracking }),
  };
  const rows = await tx
    .insert(schema.orders)
    .values({ id: newId('order'), ...values })
    .onConflictDoUpdate({
      target: [schema.orders.tenantId, schema.orders.source, schema.orders.externalId],
      set: {
        name: values.name,
        nameKey: values.nameKey,
        // Never lose a hash we had because a later payload redacted the field (Level 2 PCD).
        phoneHash: sql`coalesce(excluded.phone_hash, ${schema.orders.phoneHash})`,
        pincodeHash: sql`coalesce(excluded.pincode_hash, ${schema.orders.pincodeHash})`,
        paymentKind: sql`case when excluded.payment_kind = 'unknown' then ${schema.orders.paymentKind} else excluded.payment_kind end`,
        financialStatus: values.financialStatus,
        fulfillmentStatus: sql`coalesce(excluded.fulfillment_status, ${schema.orders.fulfillmentStatus})`,
        cancelledAt: sql`coalesce(excluded.cancelled_at, ${schema.orders.cancelledAt})`,
        totalMinor: values.totalMinor,
        currency: values.currency,
        itemSummary: values.itemSummary,
        itemCount: values.itemCount,
        sourceUpdatedAt: values.sourceUpdatedAt,
        ...(input.tracking === undefined ? {} : { tracking: input.tracking }),
      },
      setWhere: sql`${schema.orders.erasedAt} is null and (${schema.orders.sourceUpdatedAt} is null or excluded.source_updated_at is null or excluded.source_updated_at >= ${schema.orders.sourceUpdatedAt})`,
    })
    .returning({ id: schema.orders.id });
  if (rows[0] !== undefined) return { id: rows[0].id, applied: true };
  const [existing] = await tx
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.tenantId, input.tenantId),
        eq(schema.orders.source, input.source),
        eq(schema.orders.externalId, input.externalId),
      ),
    )
    .limit(1);
  if (existing === undefined) throw new Error('order upsert produced no row');
  return { id: existing.id, applied: false };
}

/** fulfillments/update and orders/fulfilled: tracking and delivery status. */
export async function applyTracking(
  tx: DbOrTx,
  input: {
    tenantId: string;
    source: OrderSource;
    externalId: string;
    tracking: Tracking;
    fulfillmentStatus: string | null;
  },
): Promise<boolean> {
  const rows = await tx
    .update(schema.orders)
    .set({
      tracking: input.tracking,
      ...(input.fulfillmentStatus === null ? {} : { fulfillmentStatus: input.fulfillmentStatus }),
    })
    .where(
      and(
        eq(schema.orders.tenantId, input.tenantId),
        eq(schema.orders.source, input.source),
        eq(schema.orders.externalId, input.externalId),
        isNull(schema.orders.erasedAt),
      ),
    )
    .returning({ id: schema.orders.id });
  return rows.length === 1;
}

export async function markOrderCancelled(
  tx: DbOrTx,
  tenantId: string,
  source: OrderSource,
  externalId: string,
  at: Date,
): Promise<void> {
  await tx
    .update(schema.orders)
    .set({ cancelledAt: sql`coalesce(${schema.orders.cancelledAt}, ${at})` })
    .where(
      and(
        eq(schema.orders.tenantId, tenantId),
        eq(schema.orders.source, source),
        eq(schema.orders.externalId, externalId),
      ),
    );
}

/**
 * E-10 / E-48 — erasure. The row stays as a tombstone so a late webhook cannot re-create it
 * (upsertOrder never touches an erased row); everything that could identify a person goes.
 */
export async function eraseOrders(
  tx: DbOrTx,
  tenantId: string,
  scope: {
    readonly externalIds?: readonly string[];
    readonly phoneHash?: string;
    readonly all?: true;
  },
  at: Date,
): Promise<number> {
  const conditions = [];
  if (scope.externalIds !== undefined && scope.externalIds.length > 0)
    conditions.push(inArray(schema.orders.externalId, [...scope.externalIds]));
  if (scope.phoneHash !== undefined) conditions.push(eq(schema.orders.phoneHash, scope.phoneHash));
  if (scope.all !== true && conditions.length === 0) return 0;
  const rows = await tx
    .update(schema.orders)
    .set({ erasedAt: at, phoneHash: null, pincodeHash: null, itemSummary: '', tracking: null })
    .where(
      and(
        eq(schema.orders.tenantId, tenantId),
        isNull(schema.orders.erasedAt),
        ...(scope.all === true ? [] : [or(...conditions)]),
      ),
    )
    .returning({ id: schema.orders.id });
  return rows.length;
}

export type OrderRow = typeof schema.orders.$inferSelect;

export async function ordersForCaller(
  tx: DbOrTx,
  tenantId: string,
  phoneHash: string,
  since: Date,
  limit: number,
): Promise<OrderRow[]> {
  return tx
    .select()
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.tenantId, tenantId),
        eq(schema.orders.phoneHash, phoneHash),
        gt(schema.orders.placedAt, since),
        isNull(schema.orders.erasedAt),
      ),
    )
    .orderBy(desc(schema.orders.placedAt))
    .limit(limit);
}

export async function countOrdersForCaller(
  tx: DbOrTx,
  tenantId: string,
  phoneHash: string,
  since: Date,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.tenantId, tenantId),
        eq(schema.orders.phoneHash, phoneHash),
        gt(schema.orders.placedAt, since),
        isNull(schema.orders.erasedAt),
      ),
    );
  return row?.n ?? 0;
}

/** Orders proven by verify_caller on this call (verified_order_ids). */
export async function ordersByIds(
  tx: DbOrTx,
  tenantId: string,
  ids: readonly string[],
): Promise<OrderRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.tenantId, tenantId),
        inArray(schema.orders.id, [...ids]),
        isNull(schema.orders.erasedAt),
      ),
    )
    .orderBy(desc(schema.orders.placedAt));
}

/** "1001", "#1001", "order 1001" → the order whose name or external id normalises the same. */
export async function orderByRef(
  tx: DbOrTx,
  tenantId: string,
  ref: string,
): Promise<OrderRow | null> {
  const key = orderNameKey(ref.replace(/^order\s*/i, ''));
  if (key.length === 0) return null;
  const [row] = await tx
    .select()
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.tenantId, tenantId),
        isNull(schema.orders.erasedAt),
        or(eq(schema.orders.nameKey, key), eq(schema.orders.externalId, key)),
      ),
    )
    .orderBy(desc(schema.orders.placedAt))
    .limit(1);
  return row ?? null;
}

/** What the agent may say about an order — plain words, no hashes, no ids beyond the order number. */
export interface OrderView {
  readonly order_ref: string;
  readonly placed_on: string;
  readonly status: 'cancelled' | 'delivered' | 'shipped' | 'processing';
  readonly payment: 'cash on delivery' | 'prepaid' | 'unknown';
  readonly total: string;
  readonly items: string;
  readonly tracking: {
    company: string | null;
    number: string | null;
    status: string | null;
    estimated_delivery: string | null;
  } | null;
}

export function toOrderView(order: OrderRow): OrderView {
  const f = (order.fulfillmentStatus ?? '').toLowerCase();
  const status: OrderView['status'] =
    order.cancelledAt !== null
      ? 'cancelled'
      : f === 'delivered'
        ? 'delivered'
        : ['fulfilled', 'shipped', 'in_transit', 'out_for_delivery', 'partial'].includes(f)
          ? 'shipped'
          : 'processing';
  const tracking = order.tracking as Tracking | null;
  const major = order.totalMinor / 100;
  return {
    order_ref: order.name,
    placed_on: order.placedAt.toISOString().slice(0, 10),
    status,
    payment:
      order.paymentKind === 'cod'
        ? 'cash on delivery'
        : order.paymentKind === 'prepaid'
          ? 'prepaid'
          : 'unknown',
    total: `${order.currency === 'INR' ? '₹' : `${order.currency} `}${Number.isInteger(major) ? String(major) : major.toFixed(2)}`,
    items: order.itemSummary,
    tracking:
      tracking === null
        ? null
        : {
            company: tracking.company,
            number: tracking.number,
            status: tracking.status,
            estimated_delivery: tracking.estimatedDelivery,
          },
  };
}
