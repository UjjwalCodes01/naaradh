import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { schema, type DbOrTx, type Tx } from '@naaradh/db';
import { addDays, newId } from '@naaradh/shared';
import type { Redis } from 'ioredis';
import { setKillSwitch } from './adapters/redis.js';
import { consentExpiresAt } from './consent.js';
import {
  COMPLAINT_GLOBAL_KILL_THRESHOLD,
  COMPLAINT_TENANT_PAUSE_THRESHOLD,
  COMPLAINT_WINDOW_DAYS,
  MINOR_ANSWERED_SUPPRESSION_DAYS,
  OPT_OUT_COOLING_DAYS,
} from './constants.js';
import type { ConsentSource, Purpose, PurposeScope, SuppressionReason } from './gate/types.js';

/**
 * The compliance ledger (AGENTS §6): consent, suppression, complaints. Side-effecting, so
 * every function takes an explicit transaction. Consents are append-only by trigger;
 * suppressions may only be lifted; complaints feed the E-05 counters.
 */

export interface RecordConsentInput {
  readonly tenantId: string;
  readonly phoneHash: string;
  readonly purpose: PurposeScope;
  readonly source: ConsentSource;
  readonly recipientRegion: string;
  readonly capturedAt: Date;
  readonly evidenceUri?: string | undefined;
  readonly wordingVersion?: string | undefined;
  readonly externalRef?: string | undefined;
  /** Non-PII capture context: checkbox id, ip hash, form name. */
  readonly context?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

/**
 * Records a grant. Any source is accepted — an `attestation` is still a fact worth keeping
 * (E-08) — but whether it is SUFFICIENT is decided by the gate, never here. `expires_at`
 * comes from the recipient region's rules, computed once and stored.
 */
export async function recordConsent(
  tx: DbOrTx,
  input: RecordConsentInput,
): Promise<{ id: string; expiresAt: Date | null }> {
  const id = newId('consent');
  // Scope 'all' expires like the strictest purpose it covers.
  const purposeForExpiry: Purpose = input.purpose === 'all' ? 'promotional' : input.purpose;
  const expiresAt = consentExpiresAt(input.recipientRegion, purposeForExpiry, input.capturedAt);
  await tx.insert(schema.consents).values({
    id,
    tenantId: input.tenantId,
    phoneHash: input.phoneHash,
    action: 'grant',
    purpose: input.purpose,
    source: input.source,
    recipientRegion: input.recipientRegion,
    evidenceUri: input.evidenceUri ?? null,
    wordingVersion: input.wordingVersion ?? null,
    externalRef: input.externalRef ?? null,
    capturedAt: input.capturedAt,
    expiresAt,
    context: input.context ?? {},
  });
  return { id, expiresAt };
}

export interface RevokeConsentInput {
  readonly tenantId: string;
  readonly phoneHash: string;
  /** Revoke grants covering this purpose; 'all' revokes everything. */
  readonly purpose: PurposeScope;
  readonly source: ConsentSource;
  readonly recipientRegion: string;
  readonly at: Date;
  readonly externalRef?: string | undefined;
}

/** Appends one revoke row per active grant. Returns the number of grants revoked. */
export async function revokeConsent(tx: DbOrTx, input: RevokeConsentInput): Promise<number> {
  const scopes: PurposeScope[] =
    input.purpose === 'all'
      ? ['transactional', 'service', 'promotional', 'all']
      : [input.purpose, 'all'];
  const grants = await tx
    .select({ id: schema.consents.id, purpose: schema.consents.purpose })
    .from(schema.consents)
    .where(
      and(
        eq(schema.consents.tenantId, input.tenantId),
        eq(schema.consents.phoneHash, input.phoneHash),
        eq(schema.consents.action, 'grant'),
        sql`${schema.consents.purpose} in ${scopes}`,
        sql`not exists (select 1 from consents r where r.action = 'revoke' and r.grant_id = ${schema.consents.id})`,
      ),
    );
  if (grants.length === 0) return 0;
  await tx.insert(schema.consents).values(
    grants.map((g) => ({
      id: newId('consent'),
      tenantId: input.tenantId,
      phoneHash: input.phoneHash,
      action: 'revoke' as const,
      grantId: g.id,
      purpose: g.purpose,
      source: input.source,
      recipientRegion: input.recipientRegion,
      externalRef: input.externalRef ?? null,
      capturedAt: input.at,
      expiresAt: null,
      context: {},
    })),
  );
  return grants.length;
}

export interface SuppressInput {
  readonly scope: 'global' | 'tenant';
  /** Required for scope 'tenant'; ignored for 'global' (which needs the service role). */
  readonly tenantId?: string;
  readonly phoneHash: string;
  readonly purpose: PurposeScope;
  readonly reason: SuppressionReason;
  readonly at: Date;
  /** E-26: scope a wrong_number to one order. */
  readonly externalRef?: string | undefined;
  /** Overrides the default duration for the reason; null = indefinite. */
  readonly untilDays?: number | null | undefined;
  readonly sourceAttemptId?: string | undefined;
  readonly createdBy: string;
  readonly notes?: string | undefined;
}

/** Default cooling periods per reason. Indefinite where the law or the person's safety says so. */
export function defaultSuppressionDays(reason: SuppressionReason): number | null {
  switch (reason) {
    case 'opt_out':
      return OPT_OUT_COOLING_DAYS;
    case 'minor':
      return MINOR_ANSWERED_SUPPRESSION_DAYS;
    case 'wrong_number':
    case 'invalid':
      return null; // scoped to the order; lifted if the number is corrected
    case 'complaint':
    case 'dnd':
    case 'manual':
    case 'recording_refused':
    case 'self_service':
    case 'erasure':
      return null;
  }
}

/**
 * Idempotent: an identical active suppression is returned rather than duplicated, so a
 * retried webhook or a double-clicked button never creates two rows to lift.
 */
export async function suppress(
  tx: DbOrTx,
  input: SuppressInput,
): Promise<{ id: string; created: boolean; until: Date | null }> {
  const tenantId = input.scope === 'global' ? null : input.tenantId;
  if (input.scope === 'tenant' && tenantId === undefined)
    throw new TypeError('tenant suppression needs tenantId');
  const days =
    input.untilDays === undefined ? defaultSuppressionDays(input.reason) : input.untilDays;
  const until = days === null ? null : addDays(input.at, days);

  const [existing] = await tx
    .select({ id: schema.suppressions.id, until: schema.suppressions.until })
    .from(schema.suppressions)
    .where(
      and(
        tenantId === null || tenantId === undefined
          ? isNull(schema.suppressions.tenantId)
          : eq(schema.suppressions.tenantId, tenantId),
        eq(schema.suppressions.phoneHash, input.phoneHash),
        eq(schema.suppressions.purpose, input.purpose),
        eq(schema.suppressions.reason, input.reason),
        input.externalRef === undefined
          ? isNull(schema.suppressions.externalRef)
          : eq(schema.suppressions.externalRef, input.externalRef),
        isNull(schema.suppressions.liftedAt),
        or(isNull(schema.suppressions.until), gt(schema.suppressions.until, input.at)),
      ),
    )
    .limit(1);
  if (existing !== undefined) return { id: existing.id, created: false, until: existing.until };

  const id = newId('suppression');
  await tx.insert(schema.suppressions).values({
    id,
    tenantId: tenantId ?? null,
    phoneHash: input.phoneHash,
    purpose: input.purpose,
    reason: input.reason,
    externalRef: input.externalRef ?? null,
    until,
    sourceAttemptId: input.sourceAttemptId ?? null,
    notes: input.notes ?? null,
    createdBy: input.createdBy,
  });
  return { id, created: true, until };
}

export async function liftSuppression(
  tx: DbOrTx,
  id: string,
  by: string,
  reason: string,
  at: Date,
): Promise<boolean> {
  const rows = await tx
    .update(schema.suppressions)
    .set({ liftedAt: at, liftedBy: by, liftedReason: reason })
    .where(and(eq(schema.suppressions.id, id), isNull(schema.suppressions.liftedAt)))
    .returning({ id: schema.suppressions.id });
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Complaints (E-05). Runs with the SERVICE role: the global count spans tenants.
// ---------------------------------------------------------------------------

export interface RecordComplaintInput {
  readonly tenantId: string;
  readonly phoneHash: string;
  readonly source: (typeof schema.complaintSource.enumValues)[number];
  readonly at: Date;
  readonly attemptId?: string | undefined;
  readonly externalRef?: string | undefined;
  readonly notes?: string | undefined;
}

export interface ComplaintOutcome {
  readonly id: string;
  readonly tenantCount: number;
  readonly globalCount: number;
  readonly tenantPaused: boolean;
  readonly globalKill: boolean;
}

/**
 * Records the complaint, suppresses the number globally (they complained — nobody calls
 * them again through Naaradh), recounts the rolling 10-day windows, and trips the tenant
 * pause at 3 and the global kill switch at 5. The alerting hook is the caller's (PagerDuty
 * / email); this function only makes the state true.
 */
export async function recordComplaint(
  tx: Tx,
  redis: Redis | null,
  input: RecordComplaintInput,
): Promise<ComplaintOutcome> {
  const id = newId('complaint');
  await tx.insert(schema.complaints).values({
    id,
    tenantId: input.tenantId,
    phoneHash: input.phoneHash,
    source: input.source,
    status: 'received',
    attemptId: input.attemptId ?? null,
    externalRef: input.externalRef ?? null,
    receivedAt: input.at,
    notes: input.notes ?? null,
  });
  await suppress(tx, {
    scope: 'global',
    phoneHash: input.phoneHash,
    purpose: 'all',
    reason: 'complaint',
    at: input.at,
    createdBy: `complaint:${id}`,
  });

  const since = addDays(input.at, -COMPLAINT_WINDOW_DAYS);
  const counted = sql`${schema.complaints.status} in ('received','valid') and ${schema.complaints.receivedAt} > ${since}`;
  const [tenantRow] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.complaints)
    .where(and(eq(schema.complaints.tenantId, input.tenantId), counted));
  const [globalRow] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.complaints)
    .where(counted);
  const tenantCount = tenantRow?.n ?? 0;
  const globalCount = globalRow?.n ?? 0;

  let tenantPaused = false;
  if (tenantCount >= COMPLAINT_TENANT_PAUSE_THRESHOLD) {
    const rows = await tx
      .update(schema.tenants)
      .set({
        status: 'paused',
        pausedAt: input.at,
        pausedReason: `complaints:${String(tenantCount)}_in_${String(COMPLAINT_WINDOW_DAYS)}d`,
      })
      .where(and(eq(schema.tenants.id, input.tenantId), eq(schema.tenants.status, 'active')))
      .returning({ id: schema.tenants.id });
    tenantPaused = rows.length === 1;
  }

  let globalKill = false;
  if (globalCount >= COMPLAINT_GLOBAL_KILL_THRESHOLD) {
    await tx
      .insert(schema.killSwitches)
      .values({
        scope: 'global',
        key: '*',
        active: true,
        reason: `complaints:${String(globalCount)}_in_${String(COMPLAINT_WINDOW_DAYS)}d`,
        setBy: `complaint:${id}`,
      })
      .onConflictDoUpdate({
        target: [schema.killSwitches.scope, schema.killSwitches.key],
        set: {
          active: true,
          reason: `complaints:${String(globalCount)}`,
          setBy: `complaint:${id}`,
          setAt: input.at,
        },
      });
    if (redis !== null) await setKillSwitch(redis, 'global', '*', true);
    globalKill = true;
  }

  return { id, tenantCount, globalCount, tenantPaused, globalKill };
}
