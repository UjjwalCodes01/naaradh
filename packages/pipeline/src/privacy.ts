import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import { eraseOrders } from './inbound/orders.js';
import { textArray } from './shopify-install.js';

/**
 * Erasure and retention data operations (AGENTS §4, P2-CMP-3/4, DPDP, Shopify redact).
 *
 * Media (recordings, transcripts) live in object storage, so every operation is split: a READ
 * that returns the object URIs, the caller deletes the objects OUTSIDE any transaction, then a
 * WRITE that nulls the URIs and scrubs rows. A crash between the two leaves URIs pointing at
 * deleted objects — the next run nulls them; it never leaves a live object with no pointer.
 *
 * Kept on purpose, as the legal record (PII-minimised — phone HASH only): consents,
 * suppressions, complaints, billing ledger, audit log, agent_actions (args already scrubbed).
 */

export interface SubjectMedia {
  readonly attemptIds: readonly string[];
  readonly uris: readonly string[];
}

/** Every recording/transcript this tenant holds for one phone hash. */
export async function subjectMedia(
  tx: DbOrTx,
  tenantId: string,
  phoneHash: string,
): Promise<SubjectMedia> {
  const rows = await tx
    .select({
      id: schema.callAttempts.id,
      recording: schema.callAttempts.recordingUri,
      transcript: schema.callAttempts.transcriptUri,
    })
    .from(schema.callAttempts)
    .where(
      and(eq(schema.callAttempts.tenantId, tenantId), eq(schema.callAttempts.phoneHash, phoneHash)),
    );
  return {
    attemptIds: rows.map((r) => r.id),
    uris: rows.flatMap((r) => [r.recording, r.transcript]).filter((u): u is string => u !== null),
  };
}

export interface ErasureCounts {
  readonly contacts: number;
  readonly attempts: number;
  readonly outcomes: number;
  readonly intents: number;
  readonly orders: number;
  readonly tickets: number;
  readonly mediaObjects: number;
}

/** Extraction keys that describe the call, not the person. Everything else is dropped. */
const OUTCOME_KEYS_KEPT = [
  'outcome',
  'confidence',
  'category',
  'cancel_reason',
  'pincode_confirmed',
  'reschedule_date',
  'quantity_change',
];

/**
 * Scrub one person from one tenant. Idempotent: a second run finds nothing left to change and
 * reports zeros. Media must already have been deleted (see file comment).
 */
export async function eraseSubject(
  tx: DbOrTx,
  input: {
    readonly tenantId: string;
    readonly phoneHash: string;
    readonly at: Date;
    readonly mediaObjectsDeleted: number;
  },
): Promise<ErasureCounts> {
  const { tenantId, phoneHash, at } = input;

  const contacts = await tx
    .update(schema.contacts)
    .set({
      erasedAt: at,
      phoneEnc: null,
      phoneEncKid: null,
      name: null,
      phoneMasked: 'erased',
      localeHint: null,
      timezone: null,
    })
    .where(
      and(
        eq(schema.contacts.tenantId, tenantId),
        eq(schema.contacts.phoneHash, phoneHash),
        isNull(schema.contacts.erasedAt),
      ),
    )
    .returning({ id: schema.contacts.id });
  const contactIds = (
    await tx
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.tenantId, tenantId), eq(schema.contacts.phoneHash, phoneHash)))
  ).map((c) => c.id);

  const attempts = await tx
    .update(schema.callAttempts)
    .set({ recordingUri: null, transcriptUri: null, mediaPurgedAt: at })
    .where(
      and(
        eq(schema.callAttempts.tenantId, tenantId),
        eq(schema.callAttempts.phoneHash, phoneHash),
        or(
          isNotNull(schema.callAttempts.recordingUri),
          isNotNull(schema.callAttempts.transcriptUri),
          isNull(schema.callAttempts.mediaPurgedAt),
        ),
      ),
    )
    .returning({ id: schema.callAttempts.id });

  const attemptIds = (
    await tx
      .select({ id: schema.callAttempts.id })
      .from(schema.callAttempts)
      .where(
        and(
          eq(schema.callAttempts.tenantId, tenantId),
          eq(schema.callAttempts.phoneHash, phoneHash),
        ),
      )
  ).map((a) => a.id);
  const keep = sql.raw(`array[${OUTCOME_KEYS_KEPT.map((k) => `'${k}'`).join(',')}]`);
  const outcomes =
    attemptIds.length === 0
      ? []
      : await tx
          .update(schema.callOutcomes)
          .set({
            extracted: sql`(select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(${schema.callOutcomes.extracted}) where key = any(${keep}))`,
          })
          .where(
            and(
              inArray(schema.callOutcomes.attemptId, attemptIds),
              sql`${schema.callOutcomes.extracted} - ${keep} <> '{}'::jsonb`,
            ),
          )
          .returning({ id: schema.callOutcomes.id });

  const intents = await tx
    .update(schema.callIntents)
    .set({ variables: sql`${schema.callIntents.variables} - 'customer_name' - 'name' - 'pincode'` })
    .where(
      and(
        eq(schema.callIntents.tenantId, tenantId),
        eq(schema.callIntents.phoneHash, phoneHash),
        sql`${schema.callIntents.variables} ?| array['customer_name','name','pincode']`,
      ),
    )
    .returning({ id: schema.callIntents.id });

  // Tool arguments carry the caller's words (an address, a ticket summary) and results carry
  // order views: nothing per subject stays behind once the contact is erased.
  // The table is append-only for every role; migration 0011's definer function blanks exactly
  // those two columns for the tenant in context and nothing else.
  if (attemptIds.length > 0)
    await tx.execute(sql`select erase_agent_actions(${textArray(attemptIds)})`);

  const orders = await eraseOrders(tx, tenantId, { phoneHash }, at);

  const tickets =
    contactIds.length === 0
      ? []
      : await tx
          .update(schema.supportTickets)
          .set({ summary: '[erased]', preferredTime: null })
          .where(
            and(
              eq(schema.supportTickets.tenantId, tenantId),
              inArray(schema.supportTickets.contactId, contactIds),
              sql`${schema.supportTickets.summary} <> '[erased]'`,
            ),
          )
          .returning({ id: schema.supportTickets.id });

  return {
    contacts: contacts.length,
    attempts: attempts.length,
    outcomes: outcomes.length,
    intents: intents.length,
    orders,
    tickets: tickets.length,
    mediaObjects: input.mediaObjectsDeleted,
  };
}

export interface MediaDue {
  readonly attemptId: string;
  readonly uris: readonly string[];
}

/** Retention (P2-CMP-4): ended attempts older than the tenant's retention that still hold media. */
export async function mediaDueForRetention(
  tx: DbOrTx,
  tenantId: string,
  cutoff: Date,
  limit: number,
): Promise<MediaDue[]> {
  const rows = await tx
    .select({
      id: schema.callAttempts.id,
      recording: schema.callAttempts.recordingUri,
      transcript: schema.callAttempts.transcriptUri,
    })
    .from(schema.callAttempts)
    .where(
      and(
        eq(schema.callAttempts.tenantId, tenantId),
        isNull(schema.callAttempts.mediaPurgedAt),
        lt(schema.callAttempts.endedAt, cutoff),
        or(
          isNotNull(schema.callAttempts.recordingUri),
          isNotNull(schema.callAttempts.transcriptUri),
        ),
      ),
    )
    .orderBy(schema.callAttempts.endedAt)
    .limit(limit);
  return rows.map((r) => ({
    attemptId: r.id,
    uris: [r.recording, r.transcript].filter((u): u is string => u !== null),
  }));
}

export async function markMediaPurged(
  tx: DbOrTx,
  tenantId: string,
  attemptIds: readonly string[],
  at: Date,
): Promise<number> {
  if (attemptIds.length === 0) return 0;
  const rows = await tx
    .update(schema.callAttempts)
    .set({ recordingUri: null, transcriptUri: null, mediaPurgedAt: at })
    .where(
      and(
        eq(schema.callAttempts.tenantId, tenantId),
        inArray(schema.callAttempts.id, [...attemptIds]),
      ),
    )
    .returning({ id: schema.callAttempts.id });
  return rows.length;
}

/** Order-cache minimisation: tombstone rows placed before the cutoff. */
export async function eraseOrdersPlacedBefore(
  tx: DbOrTx,
  tenantId: string,
  cutoff: Date,
  at: Date,
): Promise<number> {
  const rows = await tx
    .update(schema.orders)
    .set({ erasedAt: at, phoneHash: null, pincodeHash: null, itemSummary: '', tracking: null })
    .where(
      and(
        eq(schema.orders.tenantId, tenantId),
        isNull(schema.orders.erasedAt),
        lt(schema.orders.placedAt, cutoff),
      ),
    )
    .returning({ id: schema.orders.id });
  return rows.length;
}
