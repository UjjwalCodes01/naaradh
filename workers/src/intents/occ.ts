import { eq } from 'drizzle-orm';
import { schema, withTenant } from '@naaradh/db';
import { isOccProvider, parseOccCheckout } from '@naaradh/occ';
import { audit, recordCheckout } from '@naaradh/pipeline';
import type { EventMessage } from '../bus.js';
import type { WorkerContext } from '../context.js';
import { loadWebhookEvent, markWebhookFailed, markWebhookProcessed } from '../webhook-events.js';

/**
 * intents-consumer, `provider.events` — abandoned carts from a one-click checkout (E-14).
 *
 * The same three steps as the Shopify checkout path, and deliberately the same functions: read
 * the verified webhook body, map it to a cart, hand it to `recordCheckout` inside the tenant's
 * transaction. Everything that decides whether anyone gets called — the 45-minute idle debounce,
 * the 24-hour expiry, one call per cart, the consent requirement for a promotional purpose, the
 * DND scrub, the calling window — belongs to `sweepAbandonedCheckouts` and the gate, and is not
 * duplicated here. An OCC merchant therefore cannot be called under looser rules than a Shopify
 * merchant, by construction.
 *
 * Idempotent per `webhook_events` row: a redelivery of a processed event returns immediately, and
 * a re-processed cart is an upsert keyed on (tenant, source, ref) where the newest state wins.
 */
export async function handleOccEvent(ctx: WorkerContext, message: EventMessage): Promise<void> {
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
  if (!isOccProvider(event.source)) {
    await markWebhookProcessed(ctx.service, event.id, 'not_an_occ_source');
    return;
  }
  const provider = event.source;
  const now = ctx.clock.now();

  try {
    const note = await withTenant(ctx.app, tenantId, async (tx) => {
      const parsed = parseOccCheckout(provider, event.payload, now);
      if (!parsed.ok) {
        // Recorded as an auditable decision, not a crash: a provider changing a field name must
        // be visible in the dashboard rather than silently retried for ever.
        await audit(tx, {
          tenantId,
          actorType: 'system',
          action: 'checkout.rejected_payload',
          targetType: 'checkout',
          after: { source: provider, error: parsed.error.slice(0, 500) },
        });
        return 'occ:bad_payload';
      }
      const c = parsed.value;
      const [tenant] = await tx
        .select({ country: schema.tenants.country })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, tenantId))
        .limit(1);

      const result = await recordCheckout(tx, ctx.keys, {
        tenantId,
        // The provider's name is the cart's source, so a merchant who moves from Shopify
        // Checkout to GoKwik cannot have the same cart counted twice (E-139).
        source: provider,
        externalId: c.externalId,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        completedAt: c.completedAt,
        rawPhone: c.phone,
        // The recipient's own country decides the calling window (invariant 2); the tenant's is
        // the fallback when the provider sends no address.
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
      return result.kind === 'ignored'
        ? `occ:${provider}:ignored:${result.reason}`
        : `occ:${provider}:${result.status}:consent_${result.consent}`;
    });
    await markWebhookProcessed(ctx.service, event.id, note);
  } catch (error) {
    await markWebhookFailed(
      ctx.service,
      event.id,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
