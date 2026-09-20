import { and, eq, inArray } from 'drizzle-orm';
import { schema, withTenant } from '@naaradh/db';
import { ShopifyAuthError, ordersCreatedSince } from '@naaradh/shopify-sdk';
import { addMinutes } from '@naaradh/shared';
import type { WorkerContext } from '../context.js';
import { ingestShopifyOrder } from '../intents/consumer.js';
import { shopifyClientFor } from '../shopify-client.js';
import { StoreNotConnectedError } from '../results/shopify-writeback.js';

/**
 * Hourly Shopify order reconciliation (E-53, P2-SHOP-5). For every active store: list the orders
 * created since the last successful pass (5-minute overlap, at most 24 h back) and push each
 * through the `orders/create` path. Idempotency makes re-seen orders no-ops (E-52). An order found
 * after its 30-minute window keeps its original envelope (event_ts from the order, invariant 4),
 * so the gate refuses it at dispatch with `window:transactional_expired` — the merchant sees it as
 * "not called", and it is never called late.
 *
 * Runs at most once an hour across all reconcile instances (Redis NX lock).
 */
export interface ShopifyReconcileReport {
  readonly stores: number;
  readonly ordersSeen: number;
  readonly intentsCreated: number;
  readonly failures: number;
}

const HOURLY_LOCK = 'reconcile:shopify:hourly';
const watermarkKey = (tenantId: string) => `reconcile:shopify:since:${tenantId}`;

export async function reconcileShopifyOrders(
  ctx: WorkerContext,
  options: { readonly force?: boolean } = {},
): Promise<ShopifyReconcileReport | null> {
  if (options.force !== true) {
    const got = await ctx.redis.set(HOURLY_LOCK, ctx.workerId, 'EX', 55 * 60, 'NX');
    if (got !== 'OK') return null;
  }
  const now = ctx.clock.now();
  const stores = await ctx.service
    .select({ tenantId: schema.integrations.tenantId, shop: schema.integrations.externalId })
    .from(schema.integrations)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.integrations.tenantId))
    .where(
      and(
        eq(schema.integrations.kind, 'shopify'),
        eq(schema.integrations.status, 'active'),
        inArray(schema.tenants.status, ['active', 'pending_review']),
      ),
    );
  const report = { stores: 0, ordersSeen: 0, intentsCreated: 0, failures: 0 };
  for (const s of stores) {
    try {
      const store = await shopifyClientFor(ctx, s.tenantId);
      if (store === null) continue;
      const mark = await ctx.redis.get(watermarkKey(s.tenantId));
      const floor = addMinutes(now, -24 * 60);
      const last = mark === null ? addMinutes(now, -70) : new Date(mark);
      const since = new Date(Math.max(floor.getTime(), addMinutes(last, -5).getTime()));
      const orders = await ordersCreatedSince(store.client, since);
      for (const payload of orders) {
        const note = await withTenant(ctx.app, s.tenantId, (tx) =>
          ingestShopifyOrder(ctx, tx, s.tenantId, s.shop, payload, now),
        );
        if (note.startsWith('scheduled') || note.startsWith('gated') || note.startsWith('merged'))
          report.intentsCreated += 1;
      }
      report.ordersSeen += orders.length;
      report.stores += 1;
      await ctx.redis.set(watermarkKey(s.tenantId), now.toISOString(), 'EX', 7 * 86_400);
    } catch (error) {
      report.failures += 1;
      const disconnected =
        error instanceof ShopifyAuthError || error instanceof StoreNotConnectedError;
      ctx.log[disconnected ? 'warn' : 'error'](
        { err: error, tenant_id: s.tenantId },
        disconnected ? 'shopify reconcile: store not connected' : 'shopify reconcile failed',
      );
    }
  }
  if (report.intentsCreated > 0)
    // Webhooks that should have created these did not arrive: worth a look (shopify-writeback.md).
    ctx.log.warn(report, 'shopify reconcile found orders the webhooks missed (E-53)');
  return report;
}
