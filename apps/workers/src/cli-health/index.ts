import { eq, sql } from 'drizzle-orm';
import { schema } from '@naaradh/db';
import { CLI_MIN_ANSWER_RATE_7D } from '@naaradh/compliance';
import { audit } from '@naaradh/pipeline';
import { addDays, inZone } from '@naaradh/shared';
import type { WorkerContext } from '../context.js';

/**
 * cli-health (E-28, P4-OPS-2 brought forward). Once a day, per number: the share of outbound
 * dials in the last 7 days that a human answered → `numbers.answer_rate_7d`. The gate (step 11)
 * skips active numbers below CLI_MIN_ANSWER_RATE_7D on its own; this job only measures, logs
 * and audits — retiring or resting a number is a staff decision in the console (the
 * `[DECISION]` marker on E-28 in the spec), written up in docs/runbooks/cli-health.md.
 *
 * Only calls that reached the network count as dials (ENDED, NO_ANSWER, BUSY, AMD_*): an engine
 * error or a cancellation says nothing about whether carriers flag the number. Numbers with
 * fewer than CLI_HEALTH_MIN_SAMPLE dials get null ("no data"), which the gate treats as eligible
 * — a rested number is reintroduced gently rather than judged on three calls.
 */

export const CLI_HEALTH_MIN_SAMPLE = 20;
/** Local hour (Asia/Kolkata, where every number lives today) after which the day's run happens. */
export const CLI_HEALTH_LOCAL_HOUR = 2;
export const CLI_HEALTH_LOG = 'CLI answer rate below threshold';

const DIALED_STATUSES = ['ENDED', 'NO_ANSWER', 'BUSY', 'AMD_HANGUP', 'AMD_MESSAGE_LEFT'] as const;

export interface CliHealthReport {
  readonly numbers: number;
  /** Numbers with enough dials to carry a rate. */
  readonly rated: number;
  readonly belowThreshold: number;
  /** Crossed below the threshold in this run (audited + logged). */
  readonly newlyBelow: number;
}

type Stat = { number_id: string; dialed: number; human: number };

export async function computeCliHealth(ctx: WorkerContext, now: Date): Promise<CliHealthReport> {
  const since = addDays(now, -7);
  const stats = await ctx.service.execute<Stat>(sql`
    select number_id,
           count(*) filter (where status = any(${sql.raw(`array[${DIALED_STATUSES.map((s) => `'${s}'`).join(',')}]::attempt_status[]`)}))::int as dialed,
           count(*) filter (where answered_by = 'human')::int as human
    from call_attempts
    where direction = 'outbound' and number_id is not null and dispatched_at >= ${since}::timestamptz
    group by number_id
  `);
  const byNumber = new Map(stats.rows.map((s) => [s.number_id, s]));
  const numbers = await ctx.service
    .select({
      id: schema.numbers.id,
      tenantId: schema.numbers.tenantId,
      status: schema.numbers.status,
      answerRate7d: schema.numbers.answerRate7d,
    })
    .from(schema.numbers);

  const report = { numbers: numbers.length, rated: 0, belowThreshold: 0, newlyBelow: 0 };
  for (const n of numbers) {
    const s = byNumber.get(n.id);
    const dialed = s?.dialed ?? 0;
    const human = s?.human ?? 0;
    const rate =
      dialed >= CLI_HEALTH_MIN_SAMPLE ? Math.round((human / dialed) * 10_000) / 10_000 : null;
    const previous = n.answerRate7d === null ? null : Number(n.answerRate7d);
    if (rate !== null) report.rated += 1;
    const below = rate !== null && rate < CLI_MIN_ANSWER_RATE_7D;
    if (below) report.belowThreshold += 1;
    if (rate === previous) continue;
    await ctx.service
      .update(schema.numbers)
      .set({ answerRate7d: rate === null ? null : rate.toFixed(4) })
      .where(eq(schema.numbers.id, n.id));
    const wasBelow = previous !== null && previous < CLI_MIN_ANSWER_RATE_7D;
    if (below && !wasBelow) {
      report.newlyBelow += 1;
      await audit(ctx.service, {
        tenantId: n.tenantId,
        actorType: 'worker',
        actorId: ctx.workerId,
        action: 'cli.low_answer_rate',
        targetType: 'number',
        targetId: n.id,
        before: { answer_rate_7d: previous },
        after: { answer_rate_7d: rate, dialed, human, status: n.status },
      });
      ctx.log.error(
        { number_id: n.id, tenant_id: n.tenantId, answer_rate_7d: rate, dialed, status: n.status },
        `${CLI_HEALTH_LOG} — runbook cli-health.md`,
      );
    }
  }
  ctx.log.info(report, 'cli-health computed');
  return report;
}

/**
 * Runs `computeCliHealth` once per local day after CLI_HEALTH_LOCAL_HOUR, whichever reconcile
 * instance gets there first (Redis NX). A failed run releases the key so the next minute
 * retries. Returns null when there was nothing to do.
 */
export async function runCliHealthDaily(
  ctx: WorkerContext,
  now: Date,
): Promise<CliHealthReport | null> {
  const local = inZone(now, 'Asia/Kolkata');
  if (local.hour < CLI_HEALTH_LOCAL_HOUR) return null;
  const key = `cli-health:${local.toISODate() ?? now.toISOString().slice(0, 10)}`;
  const got = await ctx.redis.set(key, ctx.workerId, 'EX', 36 * 3600, 'NX');
  if (got !== 'OK') return null;
  try {
    return await computeCliHealth(ctx, now);
  } catch (error) {
    await ctx.redis.del(key);
    throw error;
  }
}
