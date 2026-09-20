import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Db } from '@naaradh/db';
import { sha256Hex, verifyShopifyHmac } from '@naaradh/shared';
import { markFailed, markProcessed, markPublished, recordWebhook } from '../events.js';
import type { Publisher } from '../pubsub.js';
import { forwardToPeer, peerForShop, type RegionDeps } from './region.js';

/**
 * POST /shopify/webhooks — every Shopify topic, including the three mandatory compliance
 * topics (customers/data_request, customers/redact, shop/redact). The topic is in the header;
 * the body is opaque here. Verify → dedupe → publish → 200, nothing else (AGENTS §3).
 *
 * Shopify's rules (SPEC §8.3): respond within 5 s; 401 on a bad HMAC; at-least-once delivery
 * so dedupe on X-Shopify-Webhook-Id. Repeated failures make Shopify drop the subscription,
 * which is why "publish failed" is a 500 (retry, please) and "unknown shop" is a 200.
 */

/** Topics we act on. Anything else is recorded as processed and ignored. */
export const SHOPIFY_TOPICS = new Set([
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'orders/fulfilled',
  'fulfillments/create',
  'fulfillments/update',
  'checkouts/create',
  'checkouts/update',
  'app/uninstalled',
  'app_subscriptions/update',
  'app_subscriptions/approaching_capped_amount',
  'shop/update',
  'customers/data_request',
  'customers/redact',
  'shop/redact',
]);

export interface ShopifyRouteDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly secretForShop: (shopDomain: string) => string;
  /** Multi-region routing (ADR-0012 §4). Absent = single region. */
  readonly region?: RegionDeps;
}

export function registerShopifyRoutes(app: FastifyInstance, deps: ShopifyRouteDeps): void {
  app.post('/shopify/webhooks', async (request, reply) => {
    const raw = request.body as Buffer;
    const h = request.headers;
    const shop = header(h['x-shopify-shop-domain']);
    const topic = header(h['x-shopify-topic']) ?? 'unknown';
    const webhookId = header(h['x-shopify-webhook-id']) ?? `sha256:${sha256Hex(raw)}`;
    const hmac = header(h['x-shopify-hmac-sha256']);

    const valid = shop !== undefined && verifyShopifyHmac(deps.secretForShop(shop), raw, hmac);
    const headersForRecord = Object.fromEntries(
      Object.entries(h).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]),
    );

    if (!valid) {
      // Recorded (no body) so abuse is visible; 401 so a misconfigured secret is loud (invariant 9).
      await recordWebhook(deps.db, {
        source: 'shopify',
        externalEventId: `rejected:${webhookId}`,
        topic,
        tenantId: null,
        externalAccount: shop ?? null,
        signatureValid: false,
        payload: null,
        payloadSha256: sha256Hex(raw),
        headers: headersForRecord,
      });
      request.log.warn({ shop, topic }, 'shopify webhook rejected: bad hmac');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    // A shop another region serves: its body is that region's data, so it is passed through
    // before anything is stored here (ADR-0012 §4, E-144).
    const peer = deps.region === undefined ? null : await peerForShop(deps.region, shop, request);
    if (peer !== null && deps.region !== undefined)
      return forwardToPeer(deps.region, peer, request, reply, raw);

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'body is not JSON' });
    }

    const [tenant] = (
      await deps.db.execute<{ tenant_id: string; tenant_status: string; status: string }>(
        sql`select tenant_id, tenant_status, status from resolve_tenant_by_integration('shopify', ${shop})`,
      )
    ).rows;

    // Several regions, and no deployment has claimed this shop yet (a fresh install whose region
    // has not synced, or a store moving between regions): its body may be another region's
    // customers' data, so nothing is stored and Shopify is asked to retry. The directory syncs
    // every 5 minutes and Shopify retries for 48 hours (ADR-0012 amendment 1, E-144).
    if (
      tenant === undefined &&
      deps.region !== undefined &&
      Object.keys(deps.region.peers).length > 0
    ) {
      request.log.warn({ shop, topic }, 'shopify webhook for a shop no region has claimed yet');
      return reply
        .code(503)
        .header('retry-after', '300')
        .send({ status: 'retry', reason: 'region_unknown' });
    }

    const recorded = await recordWebhook(deps.db, {
      source: 'shopify',
      externalEventId: webhookId,
      topic,
      tenantId: tenant?.tenant_id ?? null,
      externalAccount: shop,
      signatureValid: true,
      payload,
      payloadSha256: sha256Hex(raw),
      headers: headersForRecord,
    });

    if (recorded.kind === 'duplicate') {
      return reply.code(200).send({ status: 'duplicate', id: recorded.id });
    }

    if (tenant === undefined) {
      // A shop we do not know: shop/redact after a full purge lands here, as does noise.
      await markProcessed(deps.db, recorded.id, 'unknown_shop');
      request.log.warn({ shop, topic }, 'shopify webhook for unknown shop');
      return reply.code(200).send({ status: 'ignored', reason: 'unknown_shop', id: recorded.id });
    }
    if (!SHOPIFY_TOPICS.has(topic)) {
      await markProcessed(deps.db, recorded.id, 'unhandled_topic');
      return reply
        .code(200)
        .send({ status: 'ignored', reason: 'unhandled_topic', id: recorded.id });
    }

    try {
      const messageId = await deps.publisher.publish('shopify.events', {
        webhook_event_id: recorded.id,
        source: 'shopify',
        topic,
        tenant_id: tenant.tenant_id,
        external_account: shop,
        received_at: new Date().toISOString(),
      });
      await markPublished(deps.db, recorded.id, messageId);
      return await reply
        .code(200)
        .send({ status: recorded.kind === 'retry' ? 'republished' : 'published', id: recorded.id });
    } catch (error) {
      await markFailed(
        deps.db,
        recorded.id,
        error instanceof Error ? error.message : String(error),
      );
      request.log.error({ err: error, id: recorded.id }, 'publish failed');
      // 500 → Shopify retries → recordWebhook returns 'retry' → we publish again.
      return reply.code(500).send({ status: 'publish_failed', id: recorded.id });
    }
  });
}

function header(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}
