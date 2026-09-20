import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db, type DbOrTx } from '@naaradh/db';
import {
  QA_SAMPLE_MAX_PER_TENANT,
  QA_SAMPLE_MIN_PER_TENANT,
  QA_SAMPLE_RATE,
} from '@naaradh/compliance';
import { NaaradhError, addDays, newId } from '@naaradh/shared';
import { audit } from '../audit.js';
import { inRegion, type DataRegion } from '../promotional/checkouts.js';

/**
 * Weekly QA sampling (P4-OPS-1, ADR-0010 §11). Every Monday, 2% of last week's human-answered
 * calls per tenant (at least 1, at most 20) join the staff review queue. The sample is
 * deterministic — a hash of the attempt id and the week — so re-running the job never adds a
 * different set, and nobody can pick which calls get reviewed. Staff score each call against a
 * fixed rubric in the console; extraction accuracy per tenant comes from those reviews.
 * Service role: the queue is cross-tenant and staff-only (`qa_reviews` has no app-role grant).
 */

/** ISO 8601 week, e.g. `2026-W38`, of a UTC instant. */
export function isoWeekOf(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - day); // the Thursday of this week decides the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${String(d.getUTCFullYear())}-W${String(week).padStart(2, '0')}`;
}

/** Monday 00:00 UTC of the ISO week containing `at`. */
function weekStart(at: Date): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return addDays(d, 1 - day);
}

/** Deterministic rank in [0, 1): lower ranks are sampled first. */
export function qaSampleKey(attemptId: string, week: string): number {
  const h = createHash('sha256').update(`${week}:${attemptId}`).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}

export function qaSampleSize(calls: number): number {
  if (calls <= 0) return 0;
  return Math.min(
    calls,
    QA_SAMPLE_MAX_PER_TENANT,
    Math.max(QA_SAMPLE_MIN_PER_TENANT, Math.ceil(calls * QA_SAMPLE_RATE)),
  );
}

export interface QaSampleReport {
  readonly week: string;
  readonly tenants: number;
  readonly sampled: number;
  /** Tenants already sampled for this week (a re-run). */
  readonly alreadySampled: number;
}

/**
 * Sample the ISO week BEFORE `now`. Calls whose media was purged (retention, erasure) cannot be
 * reviewed and are not eligible; a tenant already sampled for the week is left alone, so late
 * results arriving after the run never change a published sample.
 */
export async function sampleWeeklyQa(
  service: Db,
  now: Date,
  /** ADR-0012: only this deployment's region. */
  dataRegion?: DataRegion,
): Promise<QaSampleReport> {
  const to = weekStart(now);
  const from = addDays(to, -7);
  const week = isoWeekOf(from);
  const calls = await service
    .select({ id: schema.callAttempts.id, tenantId: schema.callAttempts.tenantId })
    .from(schema.callAttempts)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.callAttempts.tenantId))
    .where(
      and(
        inRegion(dataRegion),
        eq(schema.callAttempts.answeredBy, 'human'),
        isNotNull(schema.callAttempts.endedAt),
        gte(schema.callAttempts.endedAt, from),
        lt(schema.callAttempts.endedAt, to),
        isNull(schema.callAttempts.mediaPurgedAt),
        sql`(${schema.callAttempts.recordingUri} is not null or ${schema.callAttempts.transcriptUri} is not null)`,
      ),
    );
  const byTenant = new Map<string, string[]>();
  for (const c of calls) byTenant.set(c.tenantId, [...(byTenant.get(c.tenantId) ?? []), c.id]);

  let sampled = 0;
  let alreadySampled = 0;
  for (const [tenantId, ids] of byTenant) {
    const inserted = await service.transaction(async (tx) => {
      // One sampler per tenant-week, even with two job instances racing.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`qa:${tenantId}:${week}`}))`);
      const [done] = await tx
        .select({ id: schema.qaReviews.id })
        .from(schema.qaReviews)
        .where(and(eq(schema.qaReviews.tenantId, tenantId), eq(schema.qaReviews.week, week)))
        .limit(1);
      if (done !== undefined) return null;
      const pick = [...ids]
        .sort((a, b) => qaSampleKey(a, week) - qaSampleKey(b, week))
        .slice(0, qaSampleSize(ids.length));
      const rows = await tx
        .insert(schema.qaReviews)
        .values(
          pick.map((attemptId) => ({
            id: newId('qaReview'),
            tenantId,
            attemptId,
            week,
            status: 'pending' as const,
            sampledAt: now,
          })),
        )
        .onConflictDoNothing({ target: schema.qaReviews.attemptId })
        .returning({ id: schema.qaReviews.id });
      await audit(tx, {
        tenantId,
        actorType: 'worker',
        action: 'qa.sampled',
        targetType: 'tenant',
        targetId: tenantId,
        after: { week, eligible: ids.length, sampled: rows.length },
      });
      return rows.length;
    });
    if (inserted === null) alreadySampled += 1;
    else sampled += inserted;
  }
  return { week, tenants: byTenant.size, sampled, alreadySampled };
}

/** The fixed rubric (ADR-0010 §11). Changing it changes what accuracy means — keep it stable. */
export const QA_RUBRIC = [
  {
    key: 'disclosure_ok',
    label: 'AI + recording disclosure was the first thing said',
    kind: 'bool',
  },
  { key: 'identity_ok', label: 'No order data before identity was verified', kind: 'bool' },
  { key: 'script_adherence', label: 'Followed the approved script (1–5)', kind: 'score' },
  { key: 'tone', label: 'Polite, clear, not pushy (1–5)', kind: 'score' },
  { key: 'opt_out_honoured', label: 'Any "stop calling" was honoured at once', kind: 'bool' },
  {
    key: 'prohibited_content',
    label: 'Said something it must not (discount, OTP, promise)',
    kind: 'bool',
  },
] as const;

export const QaReviewInput = z.object({
  disclosure_ok: z.boolean(),
  identity_ok: z.boolean(),
  script_adherence: z.number().int().min(1).max(5),
  tone: z.number().int().min(1).max(5),
  opt_out_honoured: z.boolean(),
  prohibited_content: z.boolean(),
  extraction_correct: z.boolean(),
  notes: z.string().trim().max(1000).nullable(),
});
export type QaReviewInput = z.infer<typeof QaReviewInput>;

export interface QaQueueRow {
  readonly id: string;
  readonly tenantId: string;
  readonly tenant: string;
  readonly attemptId: string;
  readonly week: string;
  readonly status: string;
  readonly direction: string;
  readonly purpose: string;
  readonly outcome: string | null;
  readonly extracted: unknown;
  readonly endedAt: Date | null;
  readonly transcriptUri: string | null;
  readonly reviewer: string | null;
  readonly reviewedAt: Date | null;
  readonly scores: unknown;
  readonly extractionCorrect: boolean | null;
}

export async function listQaQueue(
  service: DbOrTx,
  filter: { readonly status?: 'pending' | 'done' | 'skipped'; readonly id?: string } = {},
): Promise<QaQueueRow[]> {
  return service
    .select({
      id: schema.qaReviews.id,
      tenantId: schema.qaReviews.tenantId,
      tenant: schema.tenants.name,
      attemptId: schema.qaReviews.attemptId,
      week: schema.qaReviews.week,
      status: schema.qaReviews.status,
      direction: schema.callAttempts.direction,
      purpose: schema.callAttempts.purpose,
      outcome: schema.callOutcomes.outcome,
      extracted: schema.callOutcomes.extracted,
      endedAt: schema.callAttempts.endedAt,
      transcriptUri: schema.callAttempts.transcriptUri,
      reviewer: schema.qaReviews.reviewer,
      reviewedAt: schema.qaReviews.reviewedAt,
      scores: schema.qaReviews.scores,
      extractionCorrect: schema.qaReviews.extractionCorrect,
    })
    .from(schema.qaReviews)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.qaReviews.tenantId))
    .innerJoin(schema.callAttempts, eq(schema.callAttempts.id, schema.qaReviews.attemptId))
    .leftJoin(schema.callOutcomes, eq(schema.callOutcomes.attemptId, schema.qaReviews.attemptId))
    .where(
      and(
        filter.status === undefined ? sql`true` : eq(schema.qaReviews.status, filter.status),
        filter.id === undefined ? sql`true` : eq(schema.qaReviews.id, filter.id),
      ),
    )
    .orderBy(
      asc(schema.qaReviews.status),
      desc(schema.qaReviews.week),
      asc(schema.qaReviews.sampledAt),
    )
    .limit(200);
}

/** Record a review, or skip one (media gone, wrong language…). Once done, it stays done. */
export async function submitQaReview(
  service: DbOrTx,
  input: {
    readonly id: string;
    readonly reviewer: string;
    readonly at: Date;
  } & (
    | { readonly skip: true; readonly notes: string }
    | { readonly skip?: false; readonly review: QaReviewInput }
  ),
): Promise<boolean> {
  const set =
    input.skip === true
      ? {
          status: 'skipped' as const,
          reviewer: input.reviewer,
          reviewedAt: input.at,
          notes: input.notes.slice(0, 1000),
        }
      : (() => {
          const { extraction_correct, notes, ...scores } = input.review;
          return {
            status: 'done' as const,
            reviewer: input.reviewer,
            reviewedAt: input.at,
            scores,
            extractionCorrect: extraction_correct,
            notes,
          };
        })();
  const rows = await service
    .update(schema.qaReviews)
    .set(set)
    .where(and(eq(schema.qaReviews.id, input.id), eq(schema.qaReviews.status, 'pending')))
    .returning({
      id: schema.qaReviews.id,
      tenantId: schema.qaReviews.tenantId,
      attemptId: schema.qaReviews.attemptId,
    });
  const row = rows[0];
  if (row === undefined) {
    const [exists] = await service
      .select({ id: schema.qaReviews.id })
      .from(schema.qaReviews)
      .where(eq(schema.qaReviews.id, input.id))
      .limit(1);
    if (exists === undefined) throw new NaaradhError('NOT_FOUND', 'review not found');
    return false;
  }
  await audit(service, {
    tenantId: row.tenantId,
    actorType: 'user',
    actorId: input.reviewer,
    action: input.skip === true ? 'qa.skipped' : 'qa.reviewed',
    targetType: 'call_attempt',
    targetId: row.attemptId,
    after:
      input.skip === true
        ? { review_id: row.id }
        : {
            review_id: row.id,
            extraction_correct: input.review.extraction_correct,
            prohibited_content: input.review.prohibited_content,
            disclosure_ok: input.review.disclosure_ok,
          },
  });
  return true;
}

export interface QaAccuracyRow {
  readonly tenantId: string;
  readonly tenant: string;
  readonly reviewed: number;
  readonly extractionCorrect: number;
  readonly accuracy: number | null;
  /** Reviews that found a missing disclosure or prohibited content — each is an incident. */
  readonly incidents: number;
}

/** Per-tenant extraction accuracy over reviews completed since `since`. */
export async function qaAccuracy(service: DbOrTx, since: Date): Promise<QaAccuracyRow[]> {
  const rows = await service
    .select({
      tenantId: schema.qaReviews.tenantId,
      tenant: schema.tenants.name,
      reviewed: sql<number>`count(*)::int`,
      correct: sql<number>`count(*) filter (where ${schema.qaReviews.extractionCorrect})::int`,
      incidents: sql<number>`count(*) filter (where (${schema.qaReviews.scores}->>'disclosure_ok') = 'false' or (${schema.qaReviews.scores}->>'prohibited_content') = 'true' or (${schema.qaReviews.scores}->>'opt_out_honoured') = 'false' or (${schema.qaReviews.scores}->>'identity_ok') = 'false')::int`,
    })
    .from(schema.qaReviews)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.qaReviews.tenantId))
    .where(and(eq(schema.qaReviews.status, 'done'), gte(schema.qaReviews.reviewedAt, since)))
    .groupBy(schema.qaReviews.tenantId, schema.tenants.name)
    .orderBy(asc(schema.tenants.name));
  return rows.map((r) => ({
    tenantId: r.tenantId,
    tenant: r.tenant,
    reviewed: r.reviewed,
    extractionCorrect: r.correct,
    accuracy: r.reviewed === 0 ? null : r.correct / r.reviewed,
    incidents: r.incidents,
  }));
}
