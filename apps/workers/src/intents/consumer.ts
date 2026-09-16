import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, withTenant } from '@naaradh/db';
import {
  isCodOrder,
  parseShopifyCheckout,
  parseShopifyFulfillment,
  parseShopifyOrder,
  paymentKindOf,
} from '@naaradh/shopify-sdk';
import {
  applyTracking,
  attributeOrder,
  audit,
  cancelIntents,
  convertCheckouts,
  createFeedbackIntent,
  createIntent,
  eraseCheckouts,
  eraseOrders,
  isKnownConsentWording,
  markOrderCancelled,
  recordCheckout,
  recordOrderConsent,
  reverseAttribution,
  upsertOrder,
} from '@naaradh/pipeline';
import { addDays, newId } from '@naaradh/shared';
import { ERASURE_COMPLETION_TARGET_DAYS } from '@naaradh/compliance';
import { notifyApproachingCap, syncShopifySubscription } from '../billing/index.js';
import type { EventMessage } from '../bus.js';
import type { WorkerContext } from '../context.js';
import { loadWebhookEvent, markWebhookFailed, markWebhookProcessed } from '../webhook-events.js';

/**
 * intents-consumer (AGENTS §5.1). Turns source events into call intents, cancellations,
 * pauses and erasure requests. Idempotent per webhook_events row; every decision is
 * audited under the tenant.
 */
export async function handleShopifyEvent(ctx: WorkerContext, message: EventMessage): Promise<void> {
  const event = await loadWebhookEvent(ctx.service, message.webhook_event_id);
  if (event === null) {
    ctx.log.warn({ webhook_event_id: message.webhook_event_id }, 'webhook event not found');
    return;
  }
  if (event.status === 'processed') return; // redelivery after success
  const tenantId = event.tenantId;
  if (tenantId === null) {
    await markWebhookProcessed(ctx.service, event.id, 'no_tenant');
    return;
  }
  const now = ctx.clock.now();

  // Billing topics call Shopify back (the webhook is a hint, ADR-0008) — never inside a transaction.
  if (
    event.topic === 'app_subscriptions/update' ||
    event.topic === 'app_subscriptions/approaching_capped_amount'
  ) {
    try {
      const gid = (
        event.payload as { app_subscription?: { admin_graphql_api_id?: unknown } } | null
      )?.app_subscription?.admin_graphql_api_id;
      const note =
        typeof gid !== 'string' || !gid.startsWith('gid://shopify/AppSubscription/')
          ? 'bad_payload'
          : event.topic === 'app_subscriptions/update'
            ? await syncShopifySubscription(ctx, tenantId, gid)
            : await notifyApproachingCap(ctx, tenantId, gid);
      await markWebhookProcessed(ctx.service, event.id, note);
    } catch (error) {
      await markWebhookFailed(
        ctx.service,
        event.id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    return;
  }

  try {
    const note = await withTenant(ctx.app, tenantId, async (tx) => {
      switch (event.topic) {
        case 'orders/create':
          return ingestShopifyOrder(
            ctx,
            tx,
            tenantId,
            event.externalAccount ?? 'shopify',
            event.payload,
            now,
          );
        case 'orders/cancelled': {
          const cached = await cacheOrder(ctx, tx, tenantId, event.payload, now);
          const reversed = await reverseForOrder(tx, tenantId, event.payload, now);
          return `${await handleOrderCancelled(tx, tenantId, event.payload, now)};${cached}${reversed}`;
        }
        case 'orders/updated': {
          const cached = await cacheOrder(ctx, tx, tenantId, event.payload, now);
          const reversed = await reverseForOrder(tx, tenantId, event.payload, now);
          return `${await handleOrderUpdated(tx, tenantId, event.payload, now)};${cached}${reversed}`;
        }
        case 'orders/fulfilled':
          return cacheOrder(ctx, tx, tenantId, event.payload, now);
        case 'fulfillments/create':
        case 'fulfillments/update':
          return handleFulfillment(ctx, tx, tenantId, event.payload, now);
        case 'checkouts/create':
        case 'checkouts/update':
          return handleCheckout(ctx, tx, tenantId, event.payload, now);
        case 'app/uninstalled':
          return handleUninstalled(ctx, tx, tenantId, event.externalAccount, now);
        case 'customers/redact':
        case 'customers/data_request':
          return handleCustomerRedact(ctx, tx, tenantId, event.topic, event.payload, now);
        case 'shop/redact':
          return handleShopRedact(tx, tenantId, event.externalAccount, now);
        default:
          return `ignored:${event.topic}`;
      }
    });
    await markWebhookProcessed(ctx.service, event.id, note);
  } catch (error) {
    await markWebhookFailed(
      ctx.service,
      event.id,
      error instanceof Error ? error.message : String(error),
    );
    throw error; // nack → redelivery with backoff
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/**
 * `orders/create` ingestion — the order cache and the COD intent — shared with the hourly
 * reconcile (E-53), which feeds orders it lists from the Admin API through the same path.
 */
export async function ingestShopifyOrder(
  ctx: WorkerContext,
  tx: Tx,
  tenantId: string,
  shop: string,
  payload: unknown,
  now: Date,
): Promise<string> {
  const cached = await cacheOrder(ctx, tx, tenantId, payload, now);
  const note = await handleOrderCreate(ctx, tx, tenantId, shop, payload, now);
  const recovery = await recoveryForOrder(tx, tenantId, payload, now);
  return `${note};${cached}${recovery}`;
}

/** The cached order row for a Shopify payload, if cached and not erased. */
async function cachedOrder(tx: Tx, tenantId: string, payload: unknown) {
  const id = (payload as { id?: unknown } | null)?.id;
  if (typeof id !== 'number') return null;
  const [row] = await tx
    .select({
      id: schema.orders.id,
      phoneHash: schema.orders.phoneHash,
      checkoutToken: schema.orders.checkoutToken,
      placedAt: schema.orders.placedAt,
      totalMinor: schema.orders.totalMinor,
      currency: schema.orders.currency,
      isTest: schema.orders.isTest,
      cancelledAt: schema.orders.cancelledAt,
      erasedAt: schema.orders.erasedAt,
    })
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.tenantId, tenantId),
        eq(schema.orders.source, 'shopify'),
        eq(schema.orders.externalId, String(id)),
      ),
    )
    .limit(1);
  return row === undefined || row.erasedAt !== null ? null : row;
}

/**
 * ADR-0010: an order ends its checkout's recovery (E-102, E-103) and may be credited to an
 * earlier recovery call (§9). Every order, COD or prepaid — a recovered cart is usually prepaid.
 */
async function recoveryForOrder(
  tx: Tx,
  tenantId: string,
  payload: unknown,
  now: Date,
): Promise<string> {
  const order = await cachedOrder(tx, tenantId, payload);
  if (order === null) return '';
  const conv = await convertCheckouts(tx, {
    tenantId,
    orderId: order.id,
    phoneHash: order.phoneHash,
    checkoutToken: order.checkoutToken,
    source: 'shopify',
    placedAt: order.placedAt,
    now,
  });
  // A test order converts its checkout (nobody should be called about it) but is never credited.
  const attr =
    order.cancelledAt !== null
      ? { attributed: false as const, reason: 'order_cancelled' }
      : await attributeOrder(tx, {
          tenantId,
          orderId: order.id,
          phoneHash: order.phoneHash,
          checkoutToken: order.checkoutToken,
          placedAt: order.placedAt,
          valueMinor: order.totalMinor,
          currency: order.currency,
          isTest: order.isTest,
          now,
        });
  return `;checkouts:${String(conv.converted)}${attr.attributed ? ';recovered' : ''}`;
}

/** E-118: a cancelled order is no longer a recovery. */
async function reverseForOrder(
  tx: Tx,
  tenantId: string,
  payload: unknown,
  now: Date,
): Promise<string> {
  const cancelledAt = (payload as { cancelled_at?: unknown } | null)?.cancelled_at;
  if (typeof cancelledAt !== 'string') return '';
  const order = await cachedOrder(tx, tenantId, payload);
  if (order === null) return '';
  const n = await reverseAttribution(tx, { tenantId, orderId: order.id, at: now });
  return n > 0 ? ';attribution_reversed' : '';
}

/** checkouts/create|update (ADR-0010 §1–2): cache the checkout, record or revoke consent. */
async function handleCheckout(
  ctx: WorkerContext,
  tx: Tx,
  tenantId: string,
  payload: unknown,
  now: Date,
): Promise<string> {
  const parsed = parseShopifyCheckout(payload);
  if (!parsed.ok) {
    await audit(tx, {
      tenantId,
      actorType: 'shopify',
      action: 'checkout.rejected_payload',
      targetType: 'checkout',
      after: { error: parsed.error.slice(0, 500) },
    });
    return 'checkout:bad_payload';
  }
  const c = parsed.value;
  const [tenant] = await tx
    .select({ country: schema.tenants.country })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  const r = await recordCheckout(tx, ctx.keys, {
    tenantId,
    source: 'shopify',
    externalId: c.token,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    completedAt: c.completedAt,
    rawPhone: c.phone,
    defaultRegion: (c.countryCode ?? tenant?.country ?? 'IN') as 'IN',
    firstName: c.firstName,
    valueMinor: c.totalMinor,
    currency: c.currency,
    itemSummary: c.itemSummary,
    itemCount: c.itemCount,
    consentAttribute: c.consentAttribute,
    customerTags: c.customerTags,
    isDraftOrPos: c.isDraftOrPos,
    now,
  });
  return r.kind === 'ignored'
    ? `checkout:ignored:${r.reason}`
    : `checkout:${r.status}:consent_${r.consent}`;
}

/**
 * The order cache the voice agent answers from (ADR-0006) — every order, COD or not, because
 * a prepaid customer calls about delivery too. A late, older payload never overwrites a newer
 * one (source_updated_at), and an erased order is never re-created.
 */
async function cacheOrder(
  ctx: WorkerContext,
  tx: Tx,
  tenantId: string,
  payload: unknown,
  now: Date,
): Promise<string> {
  const parsed = parseShopifyOrder(payload);
  if (!parsed.ok) {
    // orders/cancelled can arrive as a partial payload: still record the cancellation.
    const p = payload as { id?: unknown; cancelled_at?: unknown };
    if (typeof p.id === 'number' && typeof p.cancelled_at === 'string') {
      await markOrderCancelled(tx, tenantId, 'shopify', String(p.id), new Date(p.cancelled_at));
      return 'cache:cancelled_only';
    }
    return 'cache:bad_payload';
  }
  const o = parsed.value;
  const [tenant] = await tx
    .select({ country: schema.tenants.country })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  const r = await upsertOrder(tx, ctx.keys.hashKey, {
    tenantId,
    source: 'shopify',
    externalId: String(o.order.id),
    name: o.order.name,
    rawPhone: o.phone,
    defaultRegion: (o.order.shipping_address?.country_code ?? tenant?.country ?? 'IN') as 'IN',
    pincode: o.order.shipping_address?.zip ?? null,
    paymentKind: paymentKindOf(o.order.payment_gateway_names),
    financialStatus: o.order.financial_status ?? null,
    fulfillmentStatus: o.order.fulfillment_status ?? null,
    cancelledAt:
      o.order.cancelled_at === null || o.order.cancelled_at === undefined
        ? null
        : new Date(o.order.cancelled_at),
    totalMinor: Math.round(Number(o.order.total_price) * 100),
    currency: o.order.currency,
    itemSummary: o.itemSummary,
    itemCount: o.itemCount,
    placedAt: new Date(o.order.created_at),
    sourceUpdatedAt: o.order.updated_at === undefined ? now : new Date(o.order.updated_at),
    isTest: o.isTest,
    checkoutToken: o.checkoutToken,
  });
  return r.applied ? 'cache:upserted' : 'cache:stale_ignored';
}

async function handleFulfillment(
  ctx: WorkerContext,
  tx: Tx,
  tenantId: string,
  payload: unknown,
  now: Date,
): Promise<string> {
  const parsed = parseShopifyFulfillment(payload);
  if (!parsed.ok) return 'cache:bad_fulfillment';
  const f = parsed.value;
  const applied = await applyTracking(tx, {
    tenantId,
    source: 'shopify',
    externalId: f.orderId,
    tracking: f.tracking,
    fulfillmentStatus: f.fulfillmentStatus,
  });
  // The order itself may not be cached yet (installed after it was placed): nothing to attach to.
  if (!applied) return 'cache:tracking_no_order';
  if (f.tracking.status !== 'delivered') return 'cache:tracking';
  // ADR-0010 §7: post-delivery feedback (promotional — the gate still wants consent).
  const fb = await createFeedbackIntent(tx, ctx.keys, {
    tenantId,
    source: 'shopify',
    externalOrderId: f.orderId,
    shipmentStatus: f.tracking.status,
    deliveredAt: f.updatedAt ?? now,
    now,
  });
  return `cache:tracking;feedback:${fb.status}${'reason' in fb ? `:${String(fb.reason)}` : ''}`;
}

async function handleOrderCreate(
  ctx: WorkerContext,
  tx: Tx,
  tenantId: string,
  shop: string,
  payload: unknown,
  now: Date,
): Promise<string> {
  const parsed = parseShopifyOrder(payload);
  if (!parsed.ok) {
    await audit(tx, {
      tenantId,
      actorType: 'shopify',
      action: 'intent.rejected_payload',
      targetType: 'order',
      after: { error: parsed.error },
    });
    return `bad_payload`;
  }
  const o = parsed.value;
  const gateway = isCodOrder(o.order.payment_gateway_names);
  if (!gateway.cod) {
    // E-45: not COD (or unknown gateway) → no call, but telemetry so a new provider label is noticed.
    await audit(tx, {
      tenantId,
      actorType: 'shopify',
      action: 'intent.not_cod',
      targetType: 'order',
      targetId: String(o.order.id),
      after: { gateways: o.order.payment_gateway_names, unknown: gateway.unknown },
    });
    // ADR-0010 §2: the consent box still counts on a prepaid order (recovered carts usually are).
    const consent = o.isTest
      ? ('unchanged' as const)
      : await recordOrderConsent(tx, ctx.keys, {
          tenantId,
          rawPhone: o.phone,
          defaultRegion: (o.order.shipping_address?.country_code ?? 'IN') as 'IN',
          consentAttribute: o.callConsentAttribute,
          externalOrderId: String(o.order.id),
          placedAt: new Date(o.order.created_at),
          now,
        });
    const base =
      gateway.unknown.length > 0 ? `unknown_gateway:${gateway.unknown.join('|')}` : 'not_cod';
    return consent === 'unchanged' ? base : `${base};consent_${consent}`;
  }
  const [tenant] = await tx
    .select({ name: schema.tenants.name, country: schema.tenants.country })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  const brand = tenant?.name ?? 'the store';
  const result = await createIntent(tx, ctx.keys, {
    tenantId,
    useCase: 'cod_confirm',
    source: 'shopify',
    account: shop,
    externalRef: String(o.order.id),
    eventTs: new Date(o.order.created_at),
    rawPhone: o.phone,
    defaultRegion: (o.order.shipping_address?.country_code ?? tenant?.country ?? 'IN') as 'IN',
    customerName: o.customerName,
    variables: {
      customer_name: o.customerName ?? '',
      brand,
      order_ref: o.order.name,
      amount: o.order.total_price,
      currency: o.order.currency,
      item_summary: o.itemSummary,
      item_count: o.itemCount,
      pincode: o.order.shipping_address?.zip ?? '',
    },
    valuePaise: Math.round(Number(o.order.total_price) * 100),
    currency: o.order.currency,
    isTest: o.isTest,
    tags: o.tags,
    customerTags: o.customerTags,
    // E-106: only a wording version Naaradh published is consent; anything else is ignored.
    ...(isKnownConsentWording(o.callConsentAttribute)
      ? {
          consent: {
            purpose: 'promotional' as const,
            source: 'checkout' as const,
            wordingVersion: o.callConsentAttribute,
          },
        }
      : {}),
    now,
    actor: { type: 'shopify' },
  });
  return `${result.status}${'reason' in result ? `:${String(result.reason)}` : ''}`;
}

async function handleOrderCancelled(
  tx: Tx,
  tenantId: string,
  payload: unknown,
  now: Date,
): Promise<string> {
  const id = (payload as { id?: number }).id;
  if (id === undefined) return 'bad_payload';
  const r = await cancelIntents(tx, {
    tenantId,
    externalRef: String(id),
    reason: 'orders/cancelled',
    at: now,
    actor: { type: 'shopify' },
  });
  return `cancelled:${String(r.cancelled.length)}+live:${String(r.flaggedLive.length)}`;
}

/** orders/updated: a merchant-side cancellation or a prepaid conversion removes the reason to call. */
async function handleOrderUpdated(
  tx: Tx,
  tenantId: string,
  payload: unknown,
  now: Date,
): Promise<string> {
  const o = payload as {
    id?: number;
    cancelled_at?: string | null;
    financial_status?: string | null;
  };
  if (o.id === undefined) return 'bad_payload';
  if (o.cancelled_at !== null && o.cancelled_at !== undefined) {
    const r = await cancelIntents(tx, {
      tenantId,
      externalRef: String(o.id),
      reason: 'orders/updated:cancelled',
      at: now,
      actor: { type: 'shopify' },
    });
    return `cancelled:${String(r.cancelled.length)}`;
  }
  if (o.financial_status === 'paid') {
    const r = await cancelIntents(tx, {
      tenantId,
      externalRef: String(o.id),
      reason: 'orders/updated:paid',
      at: now,
      actor: { type: 'shopify' },
    });
    return `paid_cancelled:${String(r.cancelled.length)}`;
  }
  return 'noop';
}

/** E-48: stop dispatch within 60 s, schedule the purge for shop/redact (48 h). */
async function handleUninstalled(
  ctx: WorkerContext,
  tx: Tx,
  tenantId: string,
  shop: string | null,
  now: Date,
): Promise<string> {
  const cancelled = await tx
    .update(schema.callIntents)
    .set({
      status: 'CANCELLED',
      cancelledAt: now,
      cancelReason: 'app/uninstalled',
      nextAttemptAt: null,
    })
    .where(
      and(
        eq(schema.callIntents.tenantId, tenantId),
        inArray(schema.callIntents.status, ['CREATED', 'SCHEDULED', 'RETRY_SCHEDULED', 'GATED']),
      ),
    )
    .returning({ id: schema.callIntents.id });
  await tx
    .update(schema.callIntents)
    .set({ cancelledAt: now, cancelReason: 'app/uninstalled' })
    .where(
      and(
        eq(schema.callIntents.tenantId, tenantId),
        inArray(schema.callIntents.status, ['DISPATCHING', 'IN_PROGRESS']),
      ),
    );
  if (shop !== null) {
    await tx
      .update(schema.integrations)
      .set({ status: 'uninstalled', uninstalledAt: now, purgeDueAt: addDays(now, 2) })
      .where(
        and(
          eq(schema.integrations.tenantId, tenantId),
          eq(schema.integrations.kind, 'shopify'),
          eq(schema.integrations.externalId, shop),
        ),
      );
  }
  // The store's Admin API session is useless after uninstall; delete it (data minimisation).
  // A reinstall creates a new one through the embedded app (ADR-0007).
  if (shop !== null)
    await ctx.service.delete(schema.shopifySessions).where(eq(schema.shopifySessions.shop, shop));
  // Tenant status is a service-role column (column-level grants): pause via the service handle.
  await ctx.service
    .update(schema.tenants)
    .set({ status: 'paused', pausedAt: now, pausedReason: 'app/uninstalled', uninstalledAt: now })
    .where(eq(schema.tenants.id, tenantId));
  await audit(tx, {
    tenantId,
    actorType: 'shopify',
    action: 'tenant.uninstalled',
    targetType: 'tenant',
    targetId: tenantId,
    after: { cancelled_intents: cancelled.length },
  });
  return `uninstalled:cancelled_${String(cancelled.length)}`;
}

/** customers/redact and customers/data_request: an erasure request per phone we can hash. */
async function handleCustomerRedact(
  ctx: WorkerContext,
  tx: Tx,
  tenantId: string,
  topic: string,
  payload: unknown,
  now: Date,
): Promise<string> {
  const p = payload as {
    customer?: { id?: number; phone?: string | null };
    orders_to_redact?: number[];
    orders_requested?: number[];
  };
  const phone = p.customer?.phone ?? null;
  if (topic === 'customers/redact') {
    const ids = (p.orders_to_redact ?? []).map(String);
    if (ids.length > 0) await eraseOrders(tx, tenantId, { externalIds: ids }, now);
  }
  if (topic === 'customers/data_request') {
    await audit(tx, {
      tenantId,
      actorType: 'shopify',
      action: 'privacy.data_request',
      targetType: 'customer',
      targetId: String(p.customer?.id ?? ''),
      after: { orders: p.orders_requested ?? [] },
    });
    return 'data_request_logged';
  }
  if (phone === null) {
    await audit(tx, {
      tenantId,
      actorType: 'shopify',
      action: 'privacy.redact_no_phone',
      targetType: 'customer',
      targetId: String(p.customer?.id ?? ''),
    });
    return 'redact_no_phone';
  }
  const { normalizePhone, hashPhone } = await import('@naaradh/shared');
  const parsed = normalizePhone(phone, 'IN');
  if (!parsed.ok) return 'redact_bad_phone';
  const phoneHash = hashPhone(parsed.phone.e164, ctx.keys.hashKey);
  await eraseOrders(tx, tenantId, { phoneHash }, now);
  await eraseCheckouts(tx, tenantId, { phoneHash }, now);
  await tx.insert(schema.erasureRequests).values({
    id: newId('erasure'),
    tenantId,
    phoneHash,
    source: 'shopify_redact',
    externalRef: String(p.customer?.id ?? ''),
    requestedAt: now,
    dueAt: addDays(now, ERASURE_COMPLETION_TARGET_DAYS),
  });
  await audit(tx, {
    tenantId,
    actorType: 'shopify',
    action: 'privacy.erasure_requested',
    targetType: 'contact',
    targetId: phoneHash,
  });
  return 'erasure_requested';
}

/** shop/redact (48 h after uninstall): purge everything but the legal records (E-48). */
async function handleShopRedact(
  tx: Tx,
  tenantId: string,
  shop: string | null,
  now: Date,
): Promise<string> {
  const contacts = await tx
    .select({ phoneHash: schema.contacts.phoneHash })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.tenantId, tenantId), sql`${schema.contacts.erasedAt} is null`));
  if (contacts.length > 0) {
    await tx.insert(schema.erasureRequests).values(
      contacts.map((c) => ({
        id: newId('erasure'),
        tenantId,
        phoneHash: c.phoneHash,
        source: 'shopify_redact' as const,
        externalRef: shop,
        requestedAt: now,
        dueAt: addDays(now, ERASURE_COMPLETION_TARGET_DAYS),
      })),
    );
  }
  const ordersErased = await eraseOrders(tx, tenantId, { all: true }, now);
  const checkoutsErased = await eraseCheckouts(tx, tenantId, { all: true }, now);
  if (shop !== null) {
    await tx
      .update(schema.integrations)
      .set({ purgedAt: now })
      .where(
        and(eq(schema.integrations.tenantId, tenantId), eq(schema.integrations.externalId, shop)),
      );
  }
  await audit(tx, {
    tenantId,
    actorType: 'shopify',
    action: 'privacy.shop_redact',
    targetType: 'tenant',
    targetId: tenantId,
    after: {
      erasure_requests: contacts.length,
      orders_erased: ordersErased,
      checkouts_erased: checkoutsErased,
    },
  });
  return `shop_redact:${String(contacts.length)}`;
}
