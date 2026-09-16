import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Tx } from '@naaradh/db';
import { NaaradhError, generateApiKey, newId } from '@naaradh/shared';
import { audit } from '../audit.js';
import { auditActor, type Actor } from '../admin/actor.js';
import { requireRole, type Role } from './team.js';

/**
 * API keys and webhook health for the Developers page (E-70). The key is shown once, at
 * creation; only its SHA-256 and a 12-character prefix are stored. Creating keys is an
 * owner's decision — a key can create calls. Webhook endpoints are created through the API
 * (the signing secret lives in Secret Manager); the dashboard shows their health.
 */

export const API_SCOPES = [
  'intents:create',
  'intents:read',
  'calls:read',
  'consents:write',
  'suppressions:write',
  'webhooks:read',
  'webhooks:write',
  'support:read',
  'support:write',
  'tickets:read',
  'tickets:write',
  'orders:write',
  // ADR-0011: non-Shopify carts and the appointments vertical.
  'carts:write',
  'appointments:read',
  'appointments:write',
  'complaints:read',
  'complaints:write',
  'privacy:read',
  'privacy:write',
  'billing:read',
  'billing:write',
] as const;

export const ApiKeyInput = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['secret', 'public']),
  env: z.enum(['live', 'test']).default('live'),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
  allowed_domains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'a domain like shop.example.com'),
    )
    .max(20)
    .default([]),
  daily_cap: z.number().int().min(1).max(100_000).nullable().default(null),
});
export type ApiKeyInput = z.infer<typeof ApiKeyInput>;

export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly prefix: string;
  readonly scopes: string[];
  readonly allowedDomains: string[] | null;
  readonly dailyCap: number | null;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
}

export async function listApiKeys(tx: Tx, tenantId: string): Promise<ApiKeyView[]> {
  return tx
    .select({
      id: schema.apiKeys.id,
      name: schema.apiKeys.name,
      kind: schema.apiKeys.kind,
      prefix: schema.apiKeys.prefix,
      scopes: schema.apiKeys.scopes,
      allowedDomains: schema.apiKeys.allowedDomains,
      dailyCap: schema.apiKeys.dailyCap,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      createdAt: schema.apiKeys.createdAt,
    })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.tenantId, tenantId), isNull(schema.apiKeys.revokedAt)))
    .orderBy(desc(schema.apiKeys.createdAt));
}

/** Returns the full key exactly once. Public keys: intents:create only, with a domain list. */
export async function createApiKey(
  tx: Tx,
  actor: Actor,
  actorRole: Role,
  input: ApiKeyInput,
): Promise<{ id: string; key: string; prefix: string }> {
  requireRole(actorRole, 'owner');
  if (input.kind === 'public') {
    if (input.scopes.some((s) => s !== 'intents:create'))
      throw new NaaradhError('VALIDATION_FAILED', 'public site keys may only create intents');
    if (input.allowed_domains.length === 0)
      throw new NaaradhError('VALIDATION_FAILED', 'a public site key needs at least one domain');
  }
  const generated = generateApiKey(input.kind === 'public' ? 'pk' : input.env);
  const id = newId('apiKey');
  await tx.insert(schema.apiKeys).values({
    id,
    tenantId: actor.tenantId,
    name: input.name,
    kind: input.kind,
    keyHash: generated.keyHash,
    prefix: generated.prefix,
    scopes: input.kind === 'public' ? ['intents:create'] : input.scopes,
    allowedDomains: input.kind === 'public' ? input.allowed_domains : null,
    dailyCap: input.daily_cap,
    createdByUserId: actor.type === 'user' ? actor.id : null,
  });
  await audit(tx, {
    ...auditActor(actor),
    action: 'api_key.created',
    targetType: 'api_key',
    targetId: id,
    after: { kind: input.kind, scopes: input.scopes, prefix: generated.prefix },
  });
  return { id, key: generated.key, prefix: generated.prefix };
}

export async function revokeApiKey(
  tx: Tx,
  actor: Actor,
  actorRole: Role,
  keyId: string,
  reason: string,
  now: Date,
): Promise<void> {
  requireRole(actorRole, 'owner');
  const [row] = await tx
    .update(schema.apiKeys)
    .set({ revokedAt: now, revokedReason: reason.trim().slice(0, 200) || 'revoked in dashboard' })
    .where(
      and(
        eq(schema.apiKeys.tenantId, actor.tenantId),
        eq(schema.apiKeys.id, keyId),
        isNull(schema.apiKeys.revokedAt),
      ),
    )
    .returning({ id: schema.apiKeys.id, prefix: schema.apiKeys.prefix });
  if (row === undefined) throw new NaaradhError('NOT_FOUND', 'API key not found');
  await audit(tx, {
    ...auditActor(actor),
    action: 'api_key.revoked',
    targetType: 'api_key',
    targetId: row.id,
    after: { prefix: row.prefix },
  });
}

export async function webhookHealth(tx: Tx, tenantId: string) {
  const hooks = await tx
    .select({
      id: schema.merchantWebhooks.id,
      url: schema.merchantWebhooks.url,
      events: schema.merchantWebhooks.events,
      active: schema.merchantWebhooks.active,
      consecutiveFailures: schema.merchantWebhooks.consecutiveFailures,
      disabledReason: schema.merchantWebhooks.disabledReason,
      createdAt: schema.merchantWebhooks.createdAt,
    })
    .from(schema.merchantWebhooks)
    .where(eq(schema.merchantWebhooks.tenantId, tenantId))
    .orderBy(desc(schema.merchantWebhooks.createdAt));
  const deliveries = await tx
    .select({
      id: schema.merchantWebhookDeliveries.id,
      webhookId: schema.merchantWebhookDeliveries.webhookId,
      eventType: schema.merchantWebhookDeliveries.eventType,
      status: schema.merchantWebhookDeliveries.status,
      attempts: schema.merchantWebhookDeliveries.attempts,
      lastStatusCode: schema.merchantWebhookDeliveries.lastStatusCode,
      createdAt: schema.merchantWebhookDeliveries.createdAt,
    })
    .from(schema.merchantWebhookDeliveries)
    .where(eq(schema.merchantWebhookDeliveries.tenantId, tenantId))
    .orderBy(desc(schema.merchantWebhookDeliveries.createdAt))
    .limit(50);
  return { hooks, deliveries };
}
