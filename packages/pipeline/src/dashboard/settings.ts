import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Tx } from '@naaradh/db';
import { NaaradhError, isValidZone } from '@naaradh/shared';
import { audit } from '../audit.js';
import { auditActor, type Actor } from '../admin/actor.js';
import { attestationOf } from '../billing/shopify-subscribe.js';
import { requireRole, type Role } from './team.js';

/**
 * The merchant-editable part of a tenant (column grants in migration 0001 decide which
 * columns the app role can touch at all; this decides who and how). Lifecycle, billing,
 * routing and residency stay service-role only.
 *
 * Deliberately absent: `address_write_enabled`. Naaradh never writes an address to a store
 * (Q-19); the column stays false and no surface can turn it on.
 */

export const NotificationSettings = z.object({
  daily_summary: z.boolean().default(true),
  gated_digest: z.boolean().default(true),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export function notificationSettingsOf(settings: unknown): NotificationSettings {
  const raw =
    settings !== null && typeof settings === 'object'
      ? (settings as Record<string, unknown>)['notifications']
      : undefined;
  const parsed = NotificationSettings.safeParse(raw ?? {});
  return parsed.success ? parsed.data : NotificationSettings.parse({});
}

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;

export const SettingsInput = z.object({
  name: z.string().trim().min(1).max(200),
  legal_name: z.string().trim().max(200).nullable(),
  timezone: z.string().refine(isValidZone, 'not a valid IANA time zone'),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(GSTIN, 'GSTIN must be 15 characters, e.g. 29ABCDE1234F1Z5')
    .nullable(),
  pan: z.string().trim().toUpperCase().regex(PAN, 'PAN must look like ABCDE1234F').nullable(),
  dlt_pe_id: z.string().trim().max(40).nullable(),
  spend_cap_daily_paise: z.number().int().min(10_000).nullable(),
  spend_cap_monthly_paise: z.number().int().min(10_000).nullable(),
  retention_days: z.number().int().min(30).max(365),
  amd_mode_transactional: z.enum(['hangup', 'leave_message', 'continue']),
  amd_mode_promotional: z.enum(['hangup', 'leave_message', 'continue']),
  /** Invariant 14 — even when on, only at confidence >= 0.9. */
  auto_cancel_enabled: z.boolean(),
  /** Q-07 — off: a verbal opt-out suppresses internally and is never written to Shopify. */
  shopify_sync_optout: z.boolean(),
  notifications: NotificationSettings,
  /** ADR-0010 ROI page: what one returned-to-origin COD parcel costs you, in paise. Optional. */
  rto_cost_paise: z.number().int().min(0).max(1_000_000).nullable().optional(),
  /** ADR-0010 §9: hours after a recovery call in which an order counts as recovered (1–72). */
  attribution_hours: z.number().int().min(1).max(72).optional(),
});
export type SettingsInput = z.infer<typeof SettingsInput>;

/** Settings stored in `tenants.settings` JSON rather than a column. */
export function roiSettingsOf(settings: unknown): {
  readonly rtoCostPaise: number | null;
  readonly attributionHours: number;
} {
  const s =
    settings !== null && typeof settings === 'object' ? (settings as Record<string, unknown>) : {};
  const rto = s['rto_cost_paise'];
  const hours = s['attribution_hours'];
  return {
    rtoCostPaise: typeof rto === 'number' && Number.isInteger(rto) && rto >= 0 ? rto : null,
    attributionHours:
      typeof hours === 'number' && Number.isInteger(hours) && hours >= 1 && hours <= 72
        ? hours
        : 24,
  };
}

export interface TenantSettingsView extends SettingsInput {
  readonly id: string;
  readonly country: string;
  readonly currency: string;
  readonly status: string;
  readonly pausedReason: string | null;
  readonly billingStatus: string;
  readonly billingGraceUntil: Date | null;
  readonly reviewUntil: Date | null;
  readonly dltLinkedAt: Date | null;
  readonly maxConcurrency: number;
  /** ADR-0010 §5: set by a complaint about a promotional call; only staff lift it. */
  readonly promotionalPausedAt: Date | null;
  readonly promotionalPausedReason: string | null;
  /** The onboarding compliance clickwrap, if accepted. */
  readonly attestation: { readonly version: string; readonly acceptedAt: string } | null;
}

export async function getSettings(tx: Tx, tenantId: string): Promise<TenantSettingsView> {
  const [t] = await tx
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  if (t === undefined) throw new NaaradhError('NOT_FOUND', 'account not found');
  return {
    id: t.id,
    name: t.name,
    legal_name: t.legalName,
    timezone: t.timezone,
    gstin: t.gstin,
    pan: t.pan,
    dlt_pe_id: t.dltPeId,
    spend_cap_daily_paise: t.spendCapDailyPaise,
    spend_cap_monthly_paise: t.spendCapMonthlyPaise,
    retention_days: t.retentionDays,
    amd_mode_transactional: t.amdModeTransactional,
    amd_mode_promotional: t.amdModePromotional,
    auto_cancel_enabled: t.autoCancelEnabled,
    shopify_sync_optout: t.shopifySyncOptout,
    notifications: notificationSettingsOf(t.settings),
    rto_cost_paise: roiSettingsOf(t.settings).rtoCostPaise,
    attribution_hours: roiSettingsOf(t.settings).attributionHours,
    country: t.country,
    currency: t.currency,
    status: t.status,
    pausedReason: t.pausedReason,
    billingStatus: t.billingStatus,
    billingGraceUntil: t.billingGraceUntil,
    reviewUntil: t.reviewUntil,
    dltLinkedAt: t.dltLinkedAt,
    maxConcurrency: t.maxConcurrency,
    promotionalPausedAt: t.promotionalPausedAt,
    promotionalPausedReason: t.promotionalPausedReason,
    attestation: attestationOf(t.settings),
  };
}

export async function updateSettings(
  tx: Tx,
  actor: Actor,
  actorRole: Role,
  input: SettingsInput,
): Promise<TenantSettingsView> {
  requireRole(actorRole, 'manager');
  const before = await getSettings(tx, actor.tenantId);
  const [current] = await tx
    .select({ settings: schema.tenants.settings })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, actor.tenantId))
    .limit(1);
  const settings = {
    ...((current?.settings ?? {}) as Record<string, unknown>),
    notifications: input.notifications,
    // Only when the form sent them: an older client leaves the stored values alone.
    ...(input.rto_cost_paise === undefined ? {} : { rto_cost_paise: input.rto_cost_paise }),
    ...(input.attribution_hours === undefined
      ? {}
      : { attribution_hours: input.attribution_hours }),
  };
  await tx
    .update(schema.tenants)
    .set({
      name: input.name,
      legalName: input.legal_name,
      timezone: input.timezone,
      gstin: input.gstin,
      pan: input.pan,
      dltPeId: input.dlt_pe_id,
      spendCapDailyPaise: input.spend_cap_daily_paise,
      spendCapMonthlyPaise: input.spend_cap_monthly_paise,
      retentionDays: input.retention_days,
      amdModeTransactional: input.amd_mode_transactional,
      amdModePromotional: input.amd_mode_promotional,
      autoCancelEnabled: input.auto_cancel_enabled,
      shopifySyncOptout: input.shopify_sync_optout,
      settings,
    })
    .where(eq(schema.tenants.id, actor.tenantId));
  const changed = Object.fromEntries(
    (Object.keys(input) as (keyof SettingsInput)[])
      .filter((k) => JSON.stringify(input[k]) !== JSON.stringify(before[k]))
      .map((k) => [k, { from: before[k], to: input[k] }]),
  );
  // PAN / GSTIN are business identifiers, not customer data; kept out of audit anyway.
  delete changed['pan'];
  delete changed['gstin'];
  if (Object.keys(changed).length > 0)
    await audit(tx, {
      ...auditActor(actor),
      action: 'tenant.settings_updated',
      targetType: 'tenant',
      targetId: actor.tenantId,
      after: changed,
    });
  return getSettings(tx, actor.tenantId);
}

// ---- use cases -----------------------------------------------------------------------------------

export interface UseCaseView {
  readonly id: string;
  readonly kind: string;
  readonly purpose: string;
  readonly enabled: boolean;
}

export async function listUseCases(tx: Tx, tenantId: string): Promise<UseCaseView[]> {
  return tx
    .select({
      id: schema.useCases.id,
      kind: schema.useCases.kind,
      purpose: schema.useCases.purpose,
      enabled: schema.useCases.enabled,
    })
    .from(schema.useCases)
    .where(eq(schema.useCases.tenantId, tenantId))
    .orderBy(asc(schema.useCases.kind));
}

/**
 * Turning a use case on does not bypass anything — every call still goes through the gate
 * (consent for promotional, DLT linkage, windows). A promotional use case cannot be enabled
 * before the account has a DLT PE id on file, because the gate would refuse every call.
 */
export async function setUseCaseEnabled(
  tx: Tx,
  actor: Actor,
  actorRole: Role,
  useCaseId: string,
  enabled: boolean,
): Promise<UseCaseView> {
  requireRole(actorRole, 'manager');
  const [uc] = await tx
    .select()
    .from(schema.useCases)
    .where(and(eq(schema.useCases.tenantId, actor.tenantId), eq(schema.useCases.id, useCaseId)))
    .limit(1);
  if (uc === undefined) throw new NaaradhError('NOT_FOUND', 'use case not found');
  if (enabled && uc.purpose === 'promotional') {
    const t = await getSettings(tx, actor.tenantId);
    if (t.dlt_pe_id === null)
      throw new NaaradhError(
        'VALIDATION_FAILED',
        'promotional calls need your DLT Principal Entity id first (Settings → Compliance)',
      );
    // ADR-0010 §4: switching on something the gate would refuse on every call helps nobody.
    if (t.country === 'IN') {
      const [ready] = await tx
        .select({ id: schema.scripts.id })
        .from(schema.scripts)
        .where(
          and(
            eq(schema.scripts.tenantId, actor.tenantId),
            eq(schema.scripts.useCaseId, uc.id),
            eq(schema.scripts.status, 'approved'),
            isNotNull(schema.scripts.dltTemplateId),
          ),
        )
        .limit(1);
      if (ready === undefined)
        throw new NaaradhError(
          'VALIDATION_FAILED',
          'approve a script with its DLT content template ID first (Scripts)',
        );
    }
  }
  if (uc.enabled !== enabled) {
    await tx.update(schema.useCases).set({ enabled }).where(eq(schema.useCases.id, uc.id));
    await audit(tx, {
      ...auditActor(actor),
      action: enabled ? 'use_case.enabled' : 'use_case.disabled',
      targetType: 'use_case',
      targetId: uc.id,
      after: { kind: uc.kind },
    });
  }
  return { id: uc.id, kind: uc.kind, purpose: uc.purpose, enabled };
}
