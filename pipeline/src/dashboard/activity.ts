import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';

/**
 * The merchant's access and change log (E-74: "access logs shown to merchants"). Reads the
 * tenant's own audit rows. `before`/`after` were scrubbed of PII when written (audit.ts), so
 * showing them is safe; they are still summarised, not dumped.
 */

export const ACCESS_ACTIONS = [
  'recording.accessed',
  'transcript.accessed',
  'user.signed_in',
  'user.signed_out',
  'user.invited',
  'user.role_changed',
  'user.disabled',
  'user.reenabled',
  'api_key.created',
  'api_key.revoked',
] as const;

export interface ActivityRow {
  readonly id: string;
  readonly at: Date;
  readonly actorType: string;
  readonly actor: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
}

export async function listActivity(
  tx: Tx,
  tenantId: string,
  options: { readonly accessOnly?: boolean; readonly before?: Date; readonly limit?: number } = {},
): Promise<ActivityRow[]> {
  const limit = Math.min(options.limit ?? 100, 500);
  const rows = await tx
    .select({
      id: schema.auditLog.id,
      at: schema.auditLog.at,
      actorType: schema.auditLog.actorType,
      actorId: schema.auditLog.actorId,
      action: schema.auditLog.action,
      targetType: schema.auditLog.targetType,
      targetId: schema.auditLog.targetId,
      email: schema.users.email,
    })
    .from(schema.auditLog)
    .leftJoin(
      schema.users,
      and(eq(schema.auditLog.actorType, 'user'), eq(schema.users.id, schema.auditLog.actorId)),
    )
    .where(
      and(
        eq(schema.auditLog.tenantId, tenantId),
        options.accessOnly === true
          ? inArray(schema.auditLog.action, [...ACCESS_ACTIONS])
          : sql`true`,
        options.before === undefined
          ? sql`true`
          : (or(lt(schema.auditLog.at, options.before)) ?? sql`true`),
      ),
    )
    .orderBy(desc(schema.auditLog.at), desc(schema.auditLog.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    actorType: r.actorType,
    actor:
      r.actorType === 'user'
        ? (r.email ?? r.actorId)
        : r.actorType === 'api_key'
          ? `API key ${r.actorId ?? ''}`
          : r.actorId,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
  }));
}
