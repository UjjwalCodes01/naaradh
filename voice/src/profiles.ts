import { and, desc, eq } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import { BusinessHours, describeHours } from '@naaradh/compliance';
import type { Locale } from '@naaradh/engines-core';
import {
  DEFAULT_CLOSED_MESSAGES,
  isToolName,
  substitute,
  type ToolName,
} from '@naaradh/call-scripts';
import { decryptPhone } from '@naaradh/shared';

export type ProfileRow = typeof schema.inboundProfiles.$inferSelect;
export type TransferTargetRow = typeof schema.transferTargets.$inferSelect;

export async function loadProfile(tx: DbOrTx, profileId: string): Promise<ProfileRow | null> {
  const [row] = await tx
    .select()
    .from(schema.inboundProfiles)
    .where(eq(schema.inboundProfiles.id, profileId))
    .limit(1);
  return row ?? null;
}

/** Outbound calls borrow the tenant's active support profile for tool settings (transfer target, cancel toggle). */
export async function activeProfileForTenant(
  tx: DbOrTx,
  tenantId: string,
): Promise<ProfileRow | null> {
  const [row] = await tx
    .select()
    .from(schema.inboundProfiles)
    .where(
      and(
        eq(schema.inboundProfiles.tenantId, tenantId),
        eq(schema.inboundProfiles.status, 'active'),
      ),
    )
    .orderBy(desc(schema.inboundProfiles.updatedAt))
    .limit(1);
  return row ?? null;
}

export async function loadTransferTarget(
  tx: DbOrTx,
  targetId: string | null,
): Promise<TransferTargetRow | null> {
  if (targetId === null) return null;
  const [row] = await tx
    .select()
    .from(schema.transferTargets)
    .where(eq(schema.transferTargets.id, targetId))
    .limit(1);
  return row ?? null;
}

/**
 * Validated hours or null. The API validates on write, so null means a row edited behind its
 * back — treated as "never open": no transfers, and the closed message omits hours.
 */
export function profileHours(profile: ProfileRow): BusinessHours | null {
  const parsed = BusinessHours.safeParse(profile.businessHours);
  return parsed.success ? parsed.data : null;
}

export function targetHours(target: TransferTargetRow): BusinessHours | null {
  if (target.hours === null) return null;
  const parsed = BusinessHours.safeParse(target.hours);
  return parsed.success ? parsed.data : null;
}

const INBOUND_LOCALES: readonly Locale[] = ['hi-IN', 'en-IN', 'en-US', 'en-GB'];

export function profileLocale(profile: ProfileRow | null): Locale {
  const l = profile?.locale as Locale | undefined;
  return l !== undefined && INBOUND_LOCALES.includes(l) ? l : 'en-IN';
}

export function enabledTools(profile: ProfileRow): ToolName[] {
  return profile.toolsEnabled.filter(isToolName);
}

export function hoursText(profile: ProfileRow): string {
  const hours = profileHours(profile);
  return hours === null ? '' : describeHours(hours);
}

/** E-81/E-92 — what the caller hears instead of the agent. Never empty. */
export function closedMessage(profile: ProfileRow | null, brand: string | null): string {
  const locale = profileLocale(profile);
  const lang = locale === 'hi-IN' ? 'hi-IN' : 'en-IN';
  const template = profile?.closedMessage ?? DEFAULT_CLOSED_MESSAGES[lang];
  const hours = profile === null ? '' : hoursText(profile);
  const text = substitute(template, {
    brand: brand ?? 'this business',
    hours: hours.length > 0 ? hours : 'business hours',
  });
  return text.length > 0
    ? text
    : substitute(DEFAULT_CLOSED_MESSAGES[lang], {
        brand: brand ?? 'this business',
        hours: 'business hours',
      });
}

/** Staff key only — the fallback number is the merchant's own line, never a customer's. */
export function fallbackForward(
  profile: ProfileRow | null,
  staffPrivateKeyPem: string,
): string | null {
  if (profile?.fallbackForwardEnc === null || profile?.fallbackForwardEnc === undefined)
    return null;
  try {
    return decryptPhone(profile.fallbackForwardEnc, staffPrivateKeyPem);
  } catch {
    return null;
  }
}
