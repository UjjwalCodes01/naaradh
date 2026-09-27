import { and, asc, desc, eq, gt, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import { NaaradhError } from '@naaradh/shared';

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

// ---- export (P7-ENT-1) -----------------------------------------------------------------------------

/** A year per request: an auditor's review period, and a bound on how much one request reads. */
export const AUDIT_EXPORT_MAX_DAYS = 366;
/** Rows per page of the API export, and the most a single dashboard CSV will carry. */
export const AUDIT_PAGE_SIZE = 1000;
export const AUDIT_CSV_MAX_ROWS = 100_000;

export interface AuditExportRow extends ActivityRow {
  /** `before`/`after` as written — already scrubbed of PII by audit.ts. */
  readonly before: unknown;
  readonly after: unknown;
  readonly requestId: string | null;
}

export interface AuditExportPage {
  readonly rows: AuditExportRow[];
  /** Pass back as `after` for the next page; null when there is nothing more. */
  readonly next: string | null;
}

export function auditExportRange(from: Date, to: Date): void {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
    throw new NaaradhError('VALIDATION_FAILED', 'from and to must be dates');
  if (to <= from) throw new NaaradhError('VALIDATION_FAILED', 'to must be after from');
  if (to.getTime() - from.getTime() > AUDIT_EXPORT_MAX_DAYS * 86_400_000)
    throw new NaaradhError(
      'VALIDATION_FAILED',
      `export at most ${String(AUDIT_EXPORT_MAX_DAYS)} days at a time`,
    );
}

/**
 * The tenant's audit log for [from, to), oldest first, keyset-paged on (at, id) so rows that
 * share a timestamp are never skipped or repeated across pages. The cursor is opaque to callers
 * but carries nothing secret: a timestamp and an audit id they could already read.
 */
export async function exportAuditLog(
  tx: Tx,
  tenantId: string,
  range: { readonly from: Date; readonly to: Date },
  options: { readonly after?: string | null; readonly limit?: number } = {},
): Promise<AuditExportPage> {
  auditExportRange(range.from, range.to);
  const limit = Math.min(Math.max(options.limit ?? AUDIT_PAGE_SIZE, 1), AUDIT_PAGE_SIZE);
  let cursor: { at: Date; id: string } | null = null;
  if (options.after !== undefined && options.after !== null && options.after !== '') {
    try {
      const [at, id] = Buffer.from(options.after, 'base64url').toString('utf8').split('|');
      const d = new Date(at ?? '');
      if (id === undefined || !/^aud_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) || Number.isNaN(d.getTime()))
        throw new Error('bad cursor');
      cursor = { at: d, id };
    } catch {
      throw new NaaradhError('VALIDATION_FAILED', 'after is not a cursor from this export');
    }
  }
  const rows = await tx
    .select({
      id: schema.auditLog.id,
      at: schema.auditLog.at,
      actorType: schema.auditLog.actorType,
      actorId: schema.auditLog.actorId,
      action: schema.auditLog.action,
      targetType: schema.auditLog.targetType,
      targetId: schema.auditLog.targetId,
      before: schema.auditLog.before,
      after: schema.auditLog.after,
      requestId: schema.auditLog.requestId,
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
        gte(schema.auditLog.at, range.from),
        lt(schema.auditLog.at, range.to),
        cursor === null
          ? sql`true`
          : or(
              gt(schema.auditLog.at, cursor.at),
              and(eq(schema.auditLog.at, cursor.at), gt(schema.auditLog.id, cursor.id)),
            ),
      ),
    )
    .orderBy(asc(schema.auditLog.at), asc(schema.auditLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map((r) => ({
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
      before: r.before,
      after: r.after,
      requestId: r.requestId,
    })),
    next:
      rows.length > limit && last !== undefined
        ? Buffer.from(`${last.at.toISOString()}|${last.id}`, 'utf8').toString('base64url')
        : null,
  };
}

/**
 * One CSV cell. Quotes are doubled and every cell is quoted; a cell a spreadsheet would read as a
 * formula (= + - @, tab, CR) is prefixed with an apostrophe (OWASP CSV injection) — an actor's
 * email is user-influenced, and auditors open these files in Excel.
 */
export function csvCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : value instanceof Date
        ? value.toISOString()
        : typeof value === 'string'
          ? value
          : JSON.stringify(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export const AUDIT_CSV_HEADER = [
  'at_utc',
  'actor_type',
  'actor',
  'action',
  'target_type',
  'target_id',
  'request_id',
  'before',
  'after',
];

export function auditCsvLine(r: AuditExportRow): string {
  return [
    r.at,
    r.actorType,
    r.actor,
    r.action,
    r.targetType,
    r.targetId,
    r.requestId,
    r.before,
    r.after,
  ]
    .map(csvCell)
    .join(',');
}
