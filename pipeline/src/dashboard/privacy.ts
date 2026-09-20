import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import { ERASURE_COMPLETION_TARGET_DAYS, suppress } from '@naaradh/compliance';
import {
  NaaradhError,
  addDays,
  hashPhone,
  newId,
  normalizePhone,
  type PhoneRegion,
} from '@naaradh/shared';
import { audit } from '../audit.js';
import { actorLabel, auditActor, type Actor } from '../admin/actor.js';
import { emitMerchantEvent } from '../outbox.js';
import { requireRole, type Role } from './team.js';

/**
 * Consent and suppression views, complaints and erasure requests for the dashboards
 * (P2-WEB-1). Numbers go in, hashes come out: nothing here stores or returns a phone number.
 * A suppression shows the last 6 hex characters of its hash so two rows can be told apart.
 */

function phoneHashOf(hashKey: string, phone: string, region: string): string {
  const parsed = normalizePhone(phone, region.toUpperCase() as PhoneRegion);
  if (!parsed.ok)
    throw new NaaradhError('VALIDATION_FAILED', 'phone is not a valid number', {
      context: { reason: parsed.reason },
    });
  return hashPhone(parsed.phone.e164, hashKey);
}

export interface SuppressionView {
  readonly id: string;
  readonly ref: string;
  readonly scope: 'account' | 'naaradh';
  readonly purpose: string;
  readonly reason: string;
  readonly until: Date | null;
  readonly createdAt: Date;
}

export async function listSuppressions(tx: Tx, tenantId: string): Promise<SuppressionView[]> {
  const rows = await tx
    .select({
      id: schema.suppressions.id,
      phoneHash: schema.suppressions.phoneHash,
      purpose: schema.suppressions.purpose,
      reason: schema.suppressions.reason,
      until: schema.suppressions.until,
      createdAt: schema.suppressions.createdAt,
    })
    .from(schema.suppressions)
    .where(and(eq(schema.suppressions.tenantId, tenantId), isNull(schema.suppressions.liftedAt)))
    .orderBy(desc(schema.suppressions.createdAt))
    .limit(500);
  return rows.map((r) => ({
    id: r.id,
    ref: `…${r.phoneHash.slice(-6)}`,
    scope: 'account',
    purpose: r.purpose,
    reason: r.reason,
    until: r.until,
    createdAt: r.createdAt,
  }));
}

/** "Is this number blocked, and why?" — answers from tenant AND global rows, without revealing whose. */
export async function checkNumber(
  tx: Tx,
  tenantId: string,
  hashKey: string,
  phone: string,
  region: string,
): Promise<SuppressionView[]> {
  const phoneHash = phoneHashOf(hashKey, phone, region);
  const rows = await tx
    .select({
      id: schema.suppressions.id,
      tenantId: schema.suppressions.tenantId,
      purpose: schema.suppressions.purpose,
      reason: schema.suppressions.reason,
      until: schema.suppressions.until,
      createdAt: schema.suppressions.createdAt,
    })
    .from(schema.suppressions)
    .where(and(eq(schema.suppressions.phoneHash, phoneHash), isNull(schema.suppressions.liftedAt)))
    .orderBy(desc(schema.suppressions.createdAt));
  return rows
    .filter((r) => r.tenantId === null || r.tenantId === tenantId)
    .map((r) => ({
      id: r.id,
      ref: `…${phoneHash.slice(-6)}`,
      scope: r.tenantId === null ? 'naaradh' : 'account',
      purpose: r.purpose,
      reason: r.reason,
      until: r.until,
      createdAt: r.createdAt,
    }));
}

export async function addSuppression(
  tx: Tx,
  actor: Actor,
  actorRole: Role,
  hashKey: string,
  input: {
    readonly phone: string;
    readonly region: string;
    readonly purpose: 'transactional' | 'service' | 'promotional' | 'all';
    readonly reason: 'opt_out' | 'manual' | 'wrong_number' | 'invalid';
    readonly notes?: string;
  },
  now: Date,
): Promise<{ id: string; created: boolean }> {
  requireRole(actorRole, 'operator');
  const phoneHash = phoneHashOf(hashKey, input.phone, input.region);
  const r = await suppress(tx, {
    scope: 'tenant',
    tenantId: actor.tenantId,
    phoneHash,
    purpose: input.purpose,
    reason: input.reason,
    at: now,
    notes: input.notes?.slice(0, 500),
    createdBy: actorLabel(actor),
  });
  if (r.created) {
    await audit(tx, {
      ...auditActor(actor),
      action: 'suppression.created',
      targetType: 'suppression',
      targetId: r.id,
      after: { purpose: input.purpose, reason: input.reason },
    });
    await emitMerchantEvent(tx, actor.tenantId, {
      type: 'suppression.created',
      eventId: `${r.id}:created`,
      at: now,
      data: {
        suppression_id: r.id,
        reason: input.reason,
        purpose: input.purpose,
        until: r.until?.toISOString() ?? null,
      },
    });
  }
  return { id: r.id, created: r.created };
}

/**
 * Lifting is allowed only for suppressions the merchant created by hand. A customer's own
 * opt-out, a complaint, DND, a minor or an erasure is not the merchant's to undo (universal
 * rule 6: suppressions are absolute).
 */
export async function liftSuppression(
  tx: Tx,
  actor: Actor,
  actorRole: Role,
  suppressionId: string,
  reason: string,
  now: Date,
): Promise<void> {
  requireRole(actorRole, 'manager');
  if (reason.trim().length < 10)
    throw new NaaradhError('VALIDATION_FAILED', 'say why (at least 10 characters)');
  const [s] = await tx
    .select({
      id: schema.suppressions.id,
      reason: schema.suppressions.reason,
      createdBy: schema.suppressions.createdBy,
    })
    .from(schema.suppressions)
    .where(
      and(
        eq(schema.suppressions.tenantId, actor.tenantId),
        eq(schema.suppressions.id, suppressionId),
        isNull(schema.suppressions.liftedAt),
      ),
    )
    .limit(1);
  if (s === undefined) throw new NaaradhError('NOT_FOUND', 'suppression not found');
  const byMerchant =
    s.createdBy?.startsWith('user:') === true || s.createdBy?.startsWith('api_key:') === true;
  if (!(byMerchant && (s.reason === 'manual' || s.reason === 'invalid')))
    throw new NaaradhError(
      'FORBIDDEN',
      'only suppressions your team added by hand can be lifted; customer opt-outs and complaints cannot',
    );
  await tx
    .update(schema.suppressions)
    .set({ liftedAt: now, liftedBy: actorLabel(actor), liftedReason: reason.trim().slice(0, 300) })
    .where(eq(schema.suppressions.id, s.id));
  await audit(tx, {
    ...auditActor(actor),
    action: 'suppression.lifted',
    targetType: 'suppression',
    targetId: s.id,
  });
}

export async function listComplaints(tx: Tx, tenantId: string) {
  return tx
    .select({
      id: schema.complaints.id,
      source: schema.complaints.source,
      status: schema.complaints.status,
      attemptId: schema.complaints.attemptId,
      externalRef: schema.complaints.externalRef,
      receivedAt: schema.complaints.receivedAt,
      resolvedAt: schema.complaints.resolvedAt,
    })
    .from(schema.complaints)
    .where(eq(schema.complaints.tenantId, tenantId))
    .orderBy(desc(schema.complaints.receivedAt))
    .limit(200);
}

export async function listErasureRequests(tx: Tx, tenantId: string) {
  return tx
    .select({
      id: schema.erasureRequests.id,
      source: schema.erasureRequests.source,
      status: schema.erasureRequests.status,
      requestedAt: schema.erasureRequests.requestedAt,
      dueAt: schema.erasureRequests.dueAt,
      completedAt: schema.erasureRequests.completedAt,
    })
    .from(schema.erasureRequests)
    .where(eq(schema.erasureRequests.tenantId, tenantId))
    .orderBy(desc(schema.erasureRequests.requestedAt))
    .limit(200);
}

/** A customer asked the merchant to delete their data (DPDP): the retention worker does it. */
export async function fileErasureRequest(
  tx: Tx,
  actor: Actor,
  actorRole: Role,
  hashKey: string,
  input: { readonly phone: string; readonly region: string; readonly externalRef?: string },
  now: Date,
): Promise<{ id: string; dueAt: Date }> {
  requireRole(actorRole, 'manager');
  const phoneHash = phoneHashOf(hashKey, input.phone, input.region);
  const id = newId('erasure');
  const dueAt = addDays(now, ERASURE_COMPLETION_TARGET_DAYS);
  await tx.insert(schema.erasureRequests).values({
    id,
    tenantId: actor.tenantId,
    phoneHash,
    source: 'dashboard',
    externalRef: input.externalRef?.slice(0, 200) ?? null,
    requestedAt: now,
    dueAt,
  });
  await audit(tx, {
    ...auditActor(actor),
    action: 'erasure.requested',
    targetType: 'erasure_request',
    targetId: id,
  });
  return { id, dueAt };
}
