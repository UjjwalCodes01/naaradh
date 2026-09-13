import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@naaradh/db';
import { newId } from '@naaradh/shared';

/**
 * webhook_events as the dedupe + replay store (E-22, E-52). Written with the SERVICE role:
 * a webhook arrives before any tenant context exists (ADR-0004).
 */

type Source = (typeof schema.webhookSource.enumValues)[number];

export interface RecordInput {
  readonly source: Source;
  readonly externalEventId: string;
  readonly topic: string;
  readonly tenantId: string | null;
  readonly externalAccount: string | null;
  readonly signatureValid: boolean;
  /** Null for rejected deliveries — the CHECK forbids a body on a rejected row. */
  readonly payload: unknown;
  readonly payloadSha256: string | null;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export type RecordResult =
  | { kind: 'new'; id: string }
  /** Same event id seen before but never successfully published: try again (crash-safe). */
  | { kind: 'retry'; id: string }
  | { kind: 'duplicate'; id: string };

/** Headers worth keeping for replay/debugging; never authorization or signatures. */
const KEEP_HEADERS = [
  'content-type',
  'user-agent',
  'x-shopify-topic',
  'x-shopify-shop-domain',
  'x-shopify-webhook-id',
  'x-shopify-api-version',
  'x-shopify-triggered-at',
  'x-sim-event-id',
  'x-razorpay-event-id',
];

export async function recordWebhook(db: Db, input: RecordInput): Promise<RecordResult> {
  const id = newId('webhookEvent');
  const headers: Record<string, string> = {};
  for (const h of KEEP_HEADERS) {
    const v = input.headers[h];
    if (v !== undefined) headers[h] = v;
  }
  const inserted = await db
    .insert(schema.webhookEvents)
    .values({
      id,
      source: input.source,
      externalEventId: input.externalEventId,
      topic: input.topic,
      tenantId: input.tenantId,
      externalAccount: input.externalAccount,
      status: input.signatureValid ? 'received' : 'rejected',
      signatureValid: input.signatureValid,
      payload: input.signatureValid ? input.payload : null,
      payloadSha256: input.payloadSha256,
      headers,
    })
    .onConflictDoNothing({
      target: [schema.webhookEvents.source, schema.webhookEvents.externalEventId],
    })
    .returning({ id: schema.webhookEvents.id });

  if (inserted[0] !== undefined) return { kind: 'new', id: inserted[0].id };

  const [existing] = await db
    .select({ id: schema.webhookEvents.id, status: schema.webhookEvents.status })
    .from(schema.webhookEvents)
    .where(
      sql`${schema.webhookEvents.source} = ${input.source} and ${schema.webhookEvents.externalEventId} = ${input.externalEventId}`,
    )
    .limit(1);
  if (existing === undefined) return { kind: 'duplicate', id: 'unknown' };
  if (existing.status === 'received' || existing.status === 'failed')
    return { kind: 'retry', id: existing.id };
  return { kind: 'duplicate', id: existing.id };
}

export async function markPublished(db: Db, id: string, messageId: string): Promise<void> {
  await db
    .update(schema.webhookEvents)
    .set({ status: 'published', publishedAt: new Date(), pubsubMessageId: messageId, error: null })
    .where(eq(schema.webhookEvents.id, id));
}

export async function markFailed(db: Db, id: string, error: string): Promise<void> {
  await db
    .update(schema.webhookEvents)
    .set({ status: 'failed', error: error.slice(0, 500) })
    .where(eq(schema.webhookEvents.id, id));
}

/** Nothing to publish (unknown shop, ignored topic): recorded, closed, never retried. */
export async function markProcessed(db: Db, id: string, note: string): Promise<void> {
  await db
    .update(schema.webhookEvents)
    .set({ status: 'processed', processedAt: new Date(), error: note })
    .where(eq(schema.webhookEvents.id, id));
}
