import { and, desc, eq } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import { CRM_PROVIDERS, type CrmProvider } from '@naaradh/crm';
import { OCC_PROVIDERS, type OccProvider } from '@naaradh/occ';
import { NaaradhError, newId, providerSharedSecret, providerWebhookPath } from '@naaradh/shared';
import { audit } from './audit.js';

/**
 * Connecting a merchant to a third party that posts to us: a one-click checkout (`occ` — GoKwik,
 * Shiprocket, Razorpay Magic, Cashfree, E-14) or a CRM (`crm` — Zoho, HubSpot, P5-CRM-1/2).
 *
 * Each needs two things from us, a URL and a secret, and both are derived from
 * `PROVIDER_WEBHOOK_KEY` rather than stored: there is no per-tenant secret to leak from the
 * database, and rotating that one key re-issues every merchant's URL together. What *is* stored
 * is the fact that the merchant uses the provider at all — an integration that is not active
 * means the endpoint records the delivery and acts on nothing.
 */

/** The two kinds of provider endpoint, which is also the first path segment of the URL. */
export type ProviderArea = 'occ' | 'crm';

export type ProviderKind = OccProvider | CrmProvider;

export type SignaturePolicy = 'required' | 'optional';

const AREA_OF: Readonly<Record<string, ProviderArea>> = {
  ...Object.fromEntries(OCC_PROVIDERS.map((p) => [p, 'occ' as const])),
  ...Object.fromEntries(CRM_PROVIDERS.map((p) => [p, 'crm' as const])),
};

/** Null for an integration that is not a provider endpoint (Shopify, WooCommerce, a calendar). */
export function areaOf(kind: string): ProviderArea | null {
  return AREA_OF[kind] ?? null;
}

export interface ProviderIntegration {
  readonly id: string;
  readonly area: ProviderArea;
  readonly provider: ProviderKind;
  readonly accountRef: string;
  readonly status: string;
  /** What the merchant chose, if anything. The route may still apply something stricter. */
  readonly signaturePolicy: SignaturePolicy | null;
  readonly installedAt: Date;
}

export interface ProviderCredentials {
  readonly url: string;
  /** The signing secret for providers that sign; harmless to show for those that do not. */
  readonly secret: string;
}

/** Every provider endpoint this tenant has connected, newest first. */
export async function listProviderIntegrations(
  tx: DbOrTx,
  tenantId: string,
): Promise<readonly ProviderIntegration[]> {
  const rows = await tx
    .select({
      id: schema.integrations.id,
      kind: schema.integrations.kind,
      externalId: schema.integrations.externalId,
      status: schema.integrations.status,
      metadata: schema.integrations.metadata,
      installedAt: schema.integrations.installedAt,
    })
    .from(schema.integrations)
    .where(eq(schema.integrations.tenantId, tenantId))
    .orderBy(desc(schema.integrations.installedAt));

  const out: ProviderIntegration[] = [];
  for (const row of rows) {
    const area = areaOf(row.kind);
    if (area === null) continue;
    const configured = (row.metadata as Record<string, { signature?: unknown }> | null)?.[area]
      ?.signature;
    out.push({
      id: row.id,
      area,
      provider: row.kind as ProviderKind,
      accountRef: row.externalId,
      status: row.status,
      signaturePolicy: configured === 'required' || configured === 'optional' ? configured : null,
      installedAt: row.installedAt,
    });
  }
  return out;
}

/**
 * The URL and secret for one provider. Computed, never read from the database, and only ever
 * shown to an owner (the dashboard gates the page) — anyone holding the URL can post for this
 * tenant, which is why it is treated as a credential and never logged.
 */
export function providerCredentials(
  key: string,
  baseUrl: string,
  area: ProviderArea,
  provider: ProviderKind,
  tenantId: string,
): ProviderCredentials {
  return {
    url: `${baseUrl.replace(/\/+$/, '')}${providerWebhookPath(key, area, provider, tenantId)}`,
    secret: providerSharedSecret(key, area, provider, tenantId),
  };
}

export interface EnableProviderInput {
  readonly tenantId: string;
  readonly provider: ProviderKind;
  /**
   * The merchant's account at the provider, when they know it. It is only an identifier for
   * support and for the unique index — the endpoint never trusts anything in the body to resolve
   * a tenant (the URL tag does that), so an unknown account is not a security question.
   */
  readonly accountRef?: string | null;
  /**
   * Only ever a tightening. Left undefined, the provider's own scheme applies; the route takes
   * the stricter of this and the provider's default, so no value stored here can switch
   * verification off.
   */
  readonly signaturePolicy?: SignaturePolicy;
  readonly actor: string;
}

/**
 * Enable a provider, or re-enable one that was turned off. Idempotent: enabling twice leaves one
 * row, which matters because the merchant will click it twice.
 */
export async function enableProvider(
  tx: DbOrTx,
  input: EnableProviderInput,
): Promise<{ readonly id: string; readonly created: boolean }> {
  const area = areaOf(input.provider);
  if (area === null)
    throw new NaaradhError('VALIDATION_FAILED', `${input.provider} is not a provider endpoint`);

  const accountRef =
    input.accountRef === undefined || input.accountRef === null || input.accountRef.trim() === ''
      ? `${input.provider}:${input.tenantId}`
      : input.accountRef.trim();

  const [existing] = await tx
    .select({ id: schema.integrations.id, metadata: schema.integrations.metadata })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.tenantId, input.tenantId),
        eq(schema.integrations.kind, input.provider),
      ),
    )
    .limit(1);

  const existingMeta = (existing?.metadata ?? {}) as Record<string, unknown>;
  const existingArea = (existingMeta[area] ?? {}) as Record<string, unknown>;
  const metadata =
    input.signaturePolicy === undefined
      ? undefined
      : { ...existingMeta, [area]: { ...existingArea, signature: input.signaturePolicy } };

  if (existing !== undefined) {
    await tx
      .update(schema.integrations)
      .set({
        status: 'active',
        externalId: accountRef,
        uninstalledAt: null,
        updatedAt: new Date(),
        ...(metadata === undefined ? {} : { metadata }),
      })
      .where(eq(schema.integrations.id, existing.id));
    await audit(tx, {
      tenantId: input.tenantId,
      actorType: 'user',
      actorId: input.actor,
      action: 'integration.enabled',
      targetType: 'integration',
      targetId: existing.id,
      after: { kind: input.provider, status: 'active' },
    });
    return { id: existing.id, created: false };
  }

  const id = newId('integration');
  await tx.insert(schema.integrations).values({
    id,
    tenantId: input.tenantId,
    kind: input.provider,
    externalId: accountRef,
    status: 'active',
    ...(metadata === undefined ? {} : { metadata }),
  });
  await audit(tx, {
    tenantId: input.tenantId,
    actorType: 'user',
    actorId: input.actor,
    action: 'integration.enabled',
    targetType: 'integration',
    targetId: id,
    after: { kind: input.provider, status: 'active' },
  });
  return { id, created: true };
}

/**
 * Stop acting on what a provider sends. The URL keeps answering 200 (the provider will keep
 * posting until the merchant removes it there) but nothing is acted on, which is the honest
 * behaviour: a webhook sender that starts getting errors eventually has its subscription
 * disabled, and that failure would be ours to explain.
 */
export async function disableProvider(
  tx: DbOrTx,
  input: { readonly tenantId: string; readonly provider: ProviderKind; readonly actor: string },
): Promise<void> {
  const [row] = await tx
    .select({ id: schema.integrations.id })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.tenantId, input.tenantId),
        eq(schema.integrations.kind, input.provider),
      ),
    )
    .limit(1);
  if (row === undefined)
    throw new NaaradhError('NOT_FOUND', `no ${input.provider} integration for this tenant`);

  await tx
    .update(schema.integrations)
    .set({ status: 'revoked', uninstalledAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.integrations.id, row.id));
  await audit(tx, {
    tenantId: input.tenantId,
    actorType: 'user',
    actorId: input.actor,
    action: 'integration.disabled',
    targetType: 'integration',
    targetId: row.id,
    after: { kind: input.provider, status: 'revoked' },
  });
}
