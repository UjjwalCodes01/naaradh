import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Tx } from '@naaradh/db';
import { NaaradhError, newId } from '@naaradh/shared';
import { audit } from '../audit.js';
import { auditActor, type Actor } from '../admin/actor.js';

/**
 * Dashboard users and roles (ADR-0009). Roles are ordered viewer < operator < manager < owner:
 *
 *   viewer    reads calls, tickets, billing
 *   operator  + works tickets, knowledge articles, suppressions
 *   manager   + settings, inbound profiles, scripts, transfer targets, team (up to manager)
 *   owner     + billing changes, API keys, owners
 *
 * The app role may update `users` (RLS keeps it inside the tenant); these functions are
 * where the rules live, and every change is audited. There is always at least one owner.
 */

export const ROLES = ['viewer', 'operator', 'manager', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(min);
}

export function requireRole(role: Role, min: Role): void {
  if (!roleAtLeast(role, min))
    throw new NaaradhError('FORBIDDEN', `this needs the ${min} role or above`, {
      context: { role, required: min },
    });
}

export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: Role;
  readonly lastLoginAt: Date | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
}

export async function listUsers(tx: Tx, tenantId: string): Promise<UserView[]> {
  return tx
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.users.role,
      lastLoginAt: schema.users.lastLoginAt,
      disabledAt: schema.users.disabledAt,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
    .where(eq(schema.users.tenantId, tenantId))
    .orderBy(asc(schema.users.disabledAt), asc(schema.users.createdAt));
}

export const InviteInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().max(120).nullable().default(null),
  role: z.enum(ROLES),
});
export type InviteInput = z.infer<typeof InviteInput>;

/** Managers invite up to manager; only owners create owners. Re-inviting re-enables. */
export async function inviteUser(
  tx: Tx,
  actor: Actor,
  actorRole: Role,
  input: InviteInput,
): Promise<{ id: string; created: boolean }> {
  requireRole(actorRole, 'manager');
  if (input.role === 'owner') requireRole(actorRole, 'owner');
  const [existing] = await tx
    .select({ id: schema.users.id, disabledAt: schema.users.disabledAt })
    .from(schema.users)
    .where(and(eq(schema.users.tenantId, actor.tenantId), eq(schema.users.email, input.email)))
    .limit(1);
  if (existing !== undefined) {
    if (existing.disabledAt === null)
      throw new NaaradhError('VALIDATION_FAILED', 'that person is already on the team');
    await tx
      .update(schema.users)
      .set({ disabledAt: null, role: input.role, name: input.name })
      .where(eq(schema.users.id, existing.id));
    await audit(tx, {
      ...auditActor(actor),
      action: 'user.reenabled',
      targetType: 'user',
      targetId: existing.id,
      after: { role: input.role },
    });
    return { id: existing.id, created: false };
  }
  const id = newId('user');
  await tx.insert(schema.users).values({
    id,
    tenantId: actor.tenantId,
    email: input.email,
    name: input.name,
    role: input.role,
  });
  await audit(tx, {
    ...auditActor(actor),
    action: 'user.invited',
    targetType: 'user',
    targetId: id,
    after: { role: input.role },
  });
  return { id, created: true };
}

async function ownerCount(tx: Tx, tenantId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.tenantId, tenantId),
        eq(schema.users.role, 'owner'),
        isNull(schema.users.disabledAt),
      ),
    );
  return r?.n ?? 0;
}

async function loadUser(tx: Tx, tenantId: string, userId: string) {
  const [u] = await tx
    .select({ id: schema.users.id, role: schema.users.role, disabledAt: schema.users.disabledAt })
    .from(schema.users)
    .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.id, userId)))
    .for('update')
    .limit(1);
  if (u === undefined) throw new NaaradhError('NOT_FOUND', 'user not found');
  return u;
}

export async function changeRole(
  tx: Tx,
  actor: Actor,
  actorRole: Role,
  userId: string,
  role: Role,
): Promise<void> {
  requireRole(actorRole, 'manager');
  const target = await loadUser(tx, actor.tenantId, userId);
  // Touching an owner, or making one, is an owner's decision.
  if (target.role === 'owner' || role === 'owner') requireRole(actorRole, 'owner');
  if (target.role === 'owner' && role !== 'owner' && (await ownerCount(tx, actor.tenantId)) <= 1)
    throw new NaaradhError('VALIDATION_FAILED', 'an account needs at least one owner');
  if (target.role === role) return;
  await tx.update(schema.users).set({ role }).where(eq(schema.users.id, target.id));
  await audit(tx, {
    ...auditActor(actor),
    action: 'user.role_changed',
    targetType: 'user',
    targetId: target.id,
    before: { role: target.role },
    after: { role },
  });
}

/** Disabling signs the person out everywhere at once (resolve_web_session checks disabled_at). */
export async function disableUser(
  tx: Tx,
  actor: Actor,
  actorRole: Role,
  userId: string,
  now: Date,
): Promise<void> {
  requireRole(actorRole, 'manager');
  const target = await loadUser(tx, actor.tenantId, userId);
  if (target.disabledAt !== null) return;
  if (target.role === 'owner') {
    requireRole(actorRole, 'owner');
    if ((await ownerCount(tx, actor.tenantId)) <= 1)
      throw new NaaradhError('VALIDATION_FAILED', 'an account needs at least one owner');
  }
  await tx.update(schema.users).set({ disabledAt: now }).where(eq(schema.users.id, target.id));
  await tx
    .update(schema.webSessions)
    .set({ revokedAt: now })
    .where(and(eq(schema.webSessions.userId, target.id), isNull(schema.webSessions.revokedAt)));
  await audit(tx, {
    ...auditActor(actor),
    action: 'user.disabled',
    targetType: 'user',
    targetId: target.id,
  });
}

export interface SessionView {
  readonly id: string;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
}

export async function listSessions(
  tx: Tx,
  tenantId: string,
  userId: string,
): Promise<SessionView[]> {
  return tx
    .select({
      id: schema.webSessions.id,
      userAgent: schema.webSessions.userAgent,
      createdAt: schema.webSessions.createdAt,
      lastSeenAt: schema.webSessions.lastSeenAt,
      expiresAt: schema.webSessions.expiresAt,
    })
    .from(schema.webSessions)
    .where(
      and(
        eq(schema.webSessions.tenantId, tenantId),
        eq(schema.webSessions.userId, userId),
        isNull(schema.webSessions.revokedAt),
        sql`${schema.webSessions.expiresAt} > now()`,
      ),
    )
    .orderBy(desc(schema.webSessions.lastSeenAt));
}

/** Sign out one session (logout) or every session of a user ("sign out everywhere"). */
export async function revokeSessions(
  tx: Tx,
  actor: Actor,
  target: { readonly sessionId: string } | { readonly userId: string },
  now: Date,
): Promise<number> {
  const rows = await tx
    .update(schema.webSessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.webSessions.tenantId, actor.tenantId),
        isNull(schema.webSessions.revokedAt),
        'sessionId' in target
          ? eq(schema.webSessions.id, target.sessionId)
          : eq(schema.webSessions.userId, target.userId),
      ),
    )
    .returning({ id: schema.webSessions.id });
  if (rows.length > 0)
    await audit(tx, {
      ...auditActor(actor),
      action: 'user.signed_out',
      targetType: 'sessionId' in target ? 'web_session' : 'user',
      targetId: 'sessionId' in target ? target.sessionId : target.userId,
      after: { sessions: rows.length },
    });
  return rows.length;
}
