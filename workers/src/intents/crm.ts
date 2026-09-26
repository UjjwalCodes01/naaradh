import { eq } from 'drizzle-orm';
import { schema, withTenant } from '@naaradh/db';
import { isCrmProvider, parseLead, type FieldMap } from '@naaradh/crm';
import { audit, createIntent } from '@naaradh/pipeline';
import type { EventMessage } from '../bus.js';
import type { WorkerContext } from '../context.js';
import { loadWebhookEvent, markWebhookFailed, markWebhookProcessed } from '../webhook-events.js';

/**
 * intents-consumer, `provider.events` topic `crm/lead` — a new Zoho or HubSpot lead becomes a
 * callback (P5-CRM-1/2).
 *
 * It goes through the same `createIntent()` as the public API, deliberately: the use case must be
 * enabled on the account, the number is normalised and hashed, two deliveries of the same lead
 * merge into one call (E-42), and the compliance gate decides `scheduled` or `gated`. A CRM
 * cannot make us dial anything the API could not.
 *
 * `lead_callback` is a **service** purpose, so no consent row is required — the person asked to
 * be called. A merchant who maps a consent field gets it recorded on the intent as evidence,
 * which is what makes the same lead reusable for a promotional call later.
 */
export async function handleCrmLead(ctx: WorkerContext, message: EventMessage): Promise<void> {
  const event = await loadWebhookEvent(ctx.service, message.webhook_event_id);
  if (event === null) {
    ctx.log.warn({ webhook_event_id: message.webhook_event_id }, 'webhook event not found');
    return;
  }
  if (event.status === 'processed') return;
  const tenantId = event.tenantId;
  if (tenantId === null) {
    await markWebhookProcessed(ctx.service, event.id, 'no_tenant');
    return;
  }
  if (!isCrmProvider(event.source)) {
    await markWebhookProcessed(ctx.service, event.id, 'not_a_crm_source');
    return;
  }
  const provider = event.source;
  const now = ctx.clock.now();

  try {
    const note = await withTenant(ctx.app, tenantId, async (tx) => {
      const [integration] = await tx
        .select({ metadata: schema.integrations.metadata })
        .from(schema.integrations)
        .where(eq(schema.integrations.kind, provider))
        .limit(1);

      const parsed = parseLead(provider, event.payload, fieldsOf(integration?.metadata), now);
      if (!parsed.ok) {
        await audit(tx, {
          tenantId,
          actorType: 'system',
          action: 'lead.rejected_payload',
          targetType: 'call_intent',
          after: { source: provider, error: parsed.error.slice(0, 500) },
        });
        return 'crm:bad_payload';
      }
      const lead = parsed.value;
      const [tenant] = await tx
        .select({ country: schema.tenants.country })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, tenantId))
        .limit(1);

      const result = await createIntent(tx, ctx.keys, {
        tenantId,
        useCase: 'lead_callback',
        source: provider,
        // The account the ref belongs to, i.e. this merchant's CRM: part of the idempotency key,
        // so the same lead id in two different CRMs is two leads.
        account: provider,
        externalRef: lead.externalId,
        rawPhone: lead.phone ?? '',
        defaultRegion: (lead.countryCode ?? tenant?.country ?? 'IN') as 'IN',
        eventTs: lead.createdAt ?? now,
        variables: {
          customer_name: lead.firstName ?? '',
          topic: lead.topic ?? '',
          form_name: lead.formName ?? '',
        },
        // Recorded as evidence only where the merchant actually mapped a consent field; the
        // service purpose does not need it, and inventing one would be worse than having none.
        ...(lead.consentGiven
          ? { consent: { purpose: 'service' as const, source: 'form' as const } }
          : {}),
        now,
        actor: { type: 'worker', id: ctx.workerId },
      });
      return `crm:${provider}:${result.status}`;
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

function fieldsOf(metadata: unknown): FieldMap | undefined {
  const fields = (metadata as { crm?: { fields?: unknown } } | null)?.crm?.fields;
  if (fields === null || typeof fields !== 'object') return undefined;
  const out: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) out[key] = value;
    else if (typeof value === 'string') out[key] = [value];
  }
  return out as FieldMap;
}
