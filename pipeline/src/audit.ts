import { schema, type DbOrTx } from '@naaradh/db';
import { newId } from '@naaradh/shared';

/**
 * Append-only audit trail (SPEC §11: every transition writes audit_log). `before`/`after`
 * are scrubbed of PII-shaped keys before they are stored — the audit log is the one table
 * everyone can read, so it must be the one table nothing sensitive reaches.
 */

export type ActorType = (typeof schema.actorType.enumValues)[number];

export interface AuditInput {
  readonly tenantId: string | null;
  readonly actorType: ActorType;
  readonly actorId?: string | undefined;
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | undefined;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly requestId?: string | undefined;
  readonly ipHash?: string | undefined;
}

const PII_KEYS = new Set([
  'phone',
  'phone_e164',
  'phoneE164',
  'to',
  'from',
  'to_e164',
  'from_e164',
  'msisdn',
  'mobile',
  'name',
  'customer_name',
  'customerName',
  'first_name',
  'last_name',
  'email',
  'address',
  'shipping_address',
  'billing_address',
  'transcript',
  'recording_url',
  'phone_enc',
  'phoneEnc',
  'variables',
  'extracted',
]);

/** Recursively drops PII-shaped keys; keeps structure so a diff is still readable. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return '[bytes]';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = PII_KEYS.has(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

export async function audit(tx: DbOrTx, input: AuditInput): Promise<string> {
  const id = newId('audit');
  await tx.insert(schema.auditLog).values({
    id,
    tenantId: input.tenantId,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    before: input.before === undefined ? null : scrub(input.before),
    after: input.after === undefined ? null : scrub(input.after),
    requestId: input.requestId ?? null,
    ipHash: input.ipHash ?? null,
  });
  return id;
}
