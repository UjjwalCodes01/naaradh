import { and, eq } from 'drizzle-orm';
import { schema } from '@naaradh/db';
import { createAdminClient, type AdminClient } from '@naaradh/shopify-sdk';
import type { WorkerContext } from './context.js';
import { StoreNotConnectedError } from './results/shopify-writeback.js';

/**
 * An Admin API client for a tenant's connected store (service-role read of `integrations`,
 * token from its credentials ref). Null when the tenant has no active Shopify integration.
 */
export async function shopifyClientFor(
  ctx: WorkerContext,
  tenantId: string,
): Promise<{ readonly client: AdminClient; readonly shop: string } | null> {
  const [integration] = await ctx.service
    .select({ shop: schema.integrations.externalId, ref: schema.integrations.credentialsSecretRef })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.tenantId, tenantId),
        eq(schema.integrations.kind, 'shopify'),
        eq(schema.integrations.status, 'active'),
      ),
    )
    .limit(1);
  if (integration === undefined) return null;
  if (integration.ref === null) throw new StoreNotConnectedError();
  const accessToken = await ctx.secrets.resolve(integration.ref);
  return {
    shop: integration.shop,
    client: createAdminClient({
      shop: integration.shop,
      accessToken,
      apiVersion: ctx.shopifyAdmin.apiVersion,
      ...(ctx.shopifyAdmin.fetchImpl === undefined
        ? {}
        : { fetchImpl: ctx.shopifyAdmin.fetchImpl }),
    }),
  };
}
