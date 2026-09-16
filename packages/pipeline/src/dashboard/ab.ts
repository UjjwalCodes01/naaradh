import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import { AB_MIN_ANSWERED_PER_ARM, BILLABLE_OUTCOMES } from '@naaradh/compliance';
import { validateScript } from '@naaradh/scripts';
import { NaaradhError } from '@naaradh/shared';
import { audit } from '../audit.js';
import { auditActor, type Actor } from '../admin/actor.js';
import { describeErrors } from '../admin/support.js';
import { requireRole, type Role } from './team.js';
import { requireDltTemplate } from './dlt-template.js';

/**
 * Script A/B tests (ADR-0010 §8, P4-WEB-1, SPEC §10.4). A test is two approved versions of one
 * (use case, locale): the current champion becomes arm A, a validated draft becomes arm B. The
 * gate picks the arm by the intent id. Ending a test retires the other arm. While a test runs,
 * approving any other version of that use case and locale is refused (E-116).
 */

async function approvedFor(tx: Tx, tenantId: string, useCaseId: string, locale: string) {
  return tx
    .select({ id: schema.scripts.id, abArm: schema.scripts.abArm, version: schema.scripts.version })
    .from(schema.scripts)
    .where(
      and(
        eq(schema.scripts.tenantId, tenantId),
        eq(schema.scripts.useCaseId, useCaseId),
        eq(schema.scripts.locale, locale),
        eq(schema.scripts.status, 'approved'),
      ),
    );
}

export async function isAbTestRunning(
  tx: Tx,
  tenantId: string,
  useCaseId: string,
  locale: string,
): Promise<boolean> {
  const rows = await approvedFor(tx, tenantId, useCaseId, locale);
  return rows.some((r) => r.abArm === 'B');
}

/** Start: challenger (a draft) against the current approved version. */
export async function startAbTest(
  tx: Tx,
  actor: Actor,
  actorRole: Role,
  challengerId: string,
  now: Date,
  options: { readonly dltTemplateId?: string | null } = {},
): Promise<{ championId: string; challengerId: string }> {
  requireRole(actorRole, 'manager');
  const [c] = await tx
    .select()
    .from(schema.scripts)
    .where(and(eq(schema.scripts.tenantId, actor.tenantId), eq(schema.scripts.id, challengerId)))
    .for('update')
    .limit(1);
  if (c === undefined) throw new NaaradhError('NOT_FOUND', 'script not found');
  if (c.status !== 'draft')
    throw new NaaradhError(
      'VALIDATION_FAILED',
      'only a draft version can be tested against the live one',
    );
  const v = validateScript(c.body);
  if (!v.ok)
    throw new NaaradhError('VALIDATION_FAILED', 'script fails validation', {
      context: { errors: describeErrors(v.errors) },
    });
  const live = await approvedFor(tx, actor.tenantId, c.useCaseId, c.locale);
  if (live.some((r) => r.abArm === 'B'))
    throw new NaaradhError(
      'VALIDATION_FAILED',
      'a test is already running for this script and language',
    );
  const [champion] = live;
  if (champion === undefined)
    throw new NaaradhError(
      'VALIDATION_FAILED',
      'approve a version first; a test needs a live version to compare with',
    );

  const templateId = await requireDltTemplate(
    tx,
    actor.tenantId,
    c.useCaseId,
    options.dltTemplateId?.trim() || c.dltTemplateId,
    'the challenger needs its own DLT content template ID — different wording is a different template',
  );

  await tx.update(schema.scripts).set({ abArm: 'A' }).where(eq(schema.scripts.id, champion.id));
  await tx
    .update(schema.scripts)
    .set({
      status: 'approved',
      abArm: 'B',
      disclosureValidatedAt: now,
      approvedByUserId: actor.id,
      approvedAt: now,
      dltTemplateId: templateId,
    })
    .where(eq(schema.scripts.id, c.id));
  await audit(tx, {
    ...auditActor(actor),
    action: 'script.ab_started',
    targetType: 'script',
    targetId: c.id,
    after: { champion: champion.id, challenger: c.id, locale: c.locale },
  });
  return { championId: champion.id, challengerId: c.id };
}

/** End: keep one arm, retire the other. Calls in flight keep the script id they started with. */
export async function endAbTest(
  tx: Tx,
  actor: Actor,
  actorRole: Role,
  keepId: string,
  now: Date,
): Promise<{ retiredId: string }> {
  requireRole(actorRole, 'manager');
  const [keep] = await tx
    .select()
    .from(schema.scripts)
    .where(and(eq(schema.scripts.tenantId, actor.tenantId), eq(schema.scripts.id, keepId)))
    .for('update')
    .limit(1);
  if (keep === undefined) throw new NaaradhError('NOT_FOUND', 'script not found');
  if (keep.status !== 'approved' || keep.abArm === null)
    throw new NaaradhError('VALIDATION_FAILED', 'this version is not part of a running test');
  const other = (await approvedFor(tx, actor.tenantId, keep.useCaseId, keep.locale)).find(
    (r) => r.id !== keep.id,
  );
  if (other === undefined) throw new NaaradhError('VALIDATION_FAILED', 'no other arm to retire');
  await tx
    .update(schema.scripts)
    .set({ status: 'retired', retiredAt: now, abArm: null })
    .where(eq(schema.scripts.id, other.id));
  await tx.update(schema.scripts).set({ abArm: null }).where(eq(schema.scripts.id, keep.id));
  await audit(tx, {
    ...auditActor(actor),
    action: 'script.ab_ended',
    targetType: 'script',
    targetId: keep.id,
    after: { kept: keep.id, retired: other.id },
  });
  return { retiredId: other.id };
}

export interface ArmMetrics {
  readonly scriptId: string;
  readonly arm: string;
  readonly version: number;
  readonly dialled: number;
  readonly answered: number;
  /** Answered calls that ended in a positive result for the use case. */
  readonly positive: number;
  readonly optOuts: number;
  readonly complaints: number;
  readonly answerRate: number | null;
  readonly positiveRate: number | null;
  readonly optOutRate: number | null;
}

export interface AbTestView {
  readonly useCase: string;
  readonly locale: string;
  readonly arms: readonly ArmMetrics[];
  /** Two-proportion z-test on the positive rate among answered calls; null until both arms have enough. */
  readonly pValue: number | null;
  readonly leader: string | null;
  readonly minAnsweredPerArm: number;
}

/** Positive results per use case: the billable five plus the promotional/service wins. */
const POSITIVE = [...BILLABLE_OUTCOMES, 'will_complete', 'qualified', 'feedback_given'];

/** Standard normal CDF via erf (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export function twoProportionPValue(x1: number, n1: number, x2: number, n2: number): number | null {
  if (n1 === 0 || n2 === 0) return null;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  const z = (x1 / n1 - x2 / n2) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

export async function abTestMetrics(tx: Tx, tenantId: string): Promise<AbTestView[]> {
  const arms = await tx
    .select({
      id: schema.scripts.id,
      arm: schema.scripts.abArm,
      version: schema.scripts.version,
      locale: schema.scripts.locale,
      useCase: schema.useCases.kind,
      useCaseId: schema.scripts.useCaseId,
    })
    .from(schema.scripts)
    .innerJoin(schema.useCases, eq(schema.useCases.id, schema.scripts.useCaseId))
    .where(
      and(
        eq(schema.scripts.tenantId, tenantId),
        eq(schema.scripts.status, 'approved'),
        sql`${schema.scripts.abArm} is not null`,
      ),
    );
  if (arms.length === 0) return [];
  const ids = arms.map((a) => a.id);
  const stats = await tx
    .select({
      scriptId: schema.callAttempts.scriptId,
      dialled: sql<number>`count(*) filter (where ${schema.callAttempts.dispatchedAt} is not null)::int`,
      answered: sql<number>`count(*) filter (where ${schema.callAttempts.answeredBy} = 'human')::int`,
      positive: sql<number>`count(*) filter (where ${schema.callAttempts.answeredBy} = 'human' and ${schema.callOutcomes.outcome}::text = any(${sql.raw(`array[${POSITIVE.map((p) => `'${p}'`).join(',')}]`)}))::int`,
      optOuts: sql<number>`count(*) filter (where ${schema.callOutcomes.outcome} = 'opt_out')::int`,
      complaints: sql<number>`count(distinct ${schema.complaints.id})::int`,
    })
    .from(schema.callAttempts)
    .leftJoin(schema.callOutcomes, eq(schema.callOutcomes.attemptId, schema.callAttempts.id))
    .leftJoin(schema.complaints, eq(schema.complaints.attemptId, schema.callAttempts.id))
    .where(
      and(eq(schema.callAttempts.tenantId, tenantId), inArray(schema.callAttempts.scriptId, ids)),
    )
    .groupBy(schema.callAttempts.scriptId);
  const byScript = new Map(stats.map((s) => [s.scriptId, s]));
  const groups = new Map<string, typeof arms>();
  for (const a of arms) {
    const k = `${a.useCaseId}:${a.locale}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const rate = (x: number, n: number) => (n === 0 ? null : x / n);
  return [...groups.values()].map((g) => {
    const metrics: ArmMetrics[] = g
      .sort((a, b) => (a.arm ?? '').localeCompare(b.arm ?? ''))
      .map((a) => {
        const s = byScript.get(a.id);
        const dialled = s?.dialled ?? 0;
        const answered = s?.answered ?? 0;
        const positive = s?.positive ?? 0;
        const optOuts = s?.optOuts ?? 0;
        return {
          scriptId: a.id,
          arm: a.arm ?? '?',
          version: a.version,
          dialled,
          answered,
          positive,
          optOuts,
          complaints: s?.complaints ?? 0,
          answerRate: rate(answered, dialled),
          positiveRate: rate(positive, answered),
          optOutRate: rate(optOuts, answered),
        };
      });
    const [a, b] = metrics;
    let pValue: number | null = null;
    let leader: string | null = null;
    if (
      a !== undefined &&
      b !== undefined &&
      a.answered >= AB_MIN_ANSWERED_PER_ARM &&
      b.answered >= AB_MIN_ANSWERED_PER_ARM
    ) {
      pValue = twoProportionPValue(a.positive, a.answered, b.positive, b.answered);
      if (pValue !== null && pValue < 0.05)
        leader = (a.positiveRate ?? 0) >= (b.positiveRate ?? 0) ? a.arm : b.arm;
    }
    return {
      useCase: g[0]?.useCase ?? '',
      locale: g[0]?.locale ?? '',
      arms: metrics,
      pValue,
      leader,
      minAnsweredPerArm: AB_MIN_ANSWERED_PER_ARM,
    };
  });
}
