import { DateTime } from 'luxon';
import { NaaradhError } from '@naaradh/shared';
import type { WorkerContext } from '../context.js';
import { runLoop } from '../loop.js';
import { FACT_ZONE, dailyCallFacts } from './facts.js';
import type { FactSink } from './sink.js';

export { dailyCallFacts, dailyFactSchema, DAILY_FACT_KEYS, type DailyFact } from './facts.js';
export {
  bigQuerySink,
  memorySink,
  partitionDecorator,
  type FactSink,
  type MemorySink,
} from './sink.js';

/**
 * analytics worker (P2-INF-2 / P2-WEB-2): once a night, load the previous local day's
 * `daily_call_facts` into BigQuery — and any earlier day the watermark says is still owed, so a
 * night the job missed (deploy, outage) is caught up the next night instead of leaving a hole.
 *
 * Redis holds two keys: `analytics:daily` (NX lock, one run at a time) and `analytics:watermark`
 * (the last day fully loaded). A day's load is atomic on the BigQuery side (WRITE_TRUNCATE on the
 * partition), so a crash between days leaves the watermark on the last good one and the next
 * run repeats from there. Nothing per-subject is read or written here (see facts.ts).
 */

export const ANALYTICS_LOCK = 'analytics:daily';
export const ANALYTICS_WATERMARK = 'analytics:watermark';
/** Local hour (Asia/Kolkata) after which the day's run starts. */
export const ANALYTICS_LOCAL_HOUR = 1;
export const ANALYTICS_LOCAL_MINUTE = 30;
/** First run: how far back to load. */
export const ANALYTICS_BACKFILL_DAYS = 7;
/** Safety valve: never load more than this many days in one run. */
export const ANALYTICS_MAX_DAYS_PER_RUN = 31;

export interface AnalyticsReport {
  readonly days: readonly string[];
  readonly rows: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Every local day after `watermark` up to and including `until`, oldest first. */
export function daysOwed(watermark: string | null, until: string): string[] {
  const end = DateTime.fromISO(until, { zone: FACT_ZONE });
  if (!DAY.test(until) || !end.isValid)
    throw new NaaradhError('VALIDATION_FAILED', 'analytics: until must be YYYY-MM-DD');
  const from =
    watermark !== null &&
    DAY.test(watermark) &&
    DateTime.fromISO(watermark, { zone: FACT_ZONE }).isValid
      ? DateTime.fromISO(watermark, { zone: FACT_ZONE }).plus({ days: 1 })
      : end.minus({ days: ANALYTICS_BACKFILL_DAYS - 1 });
  const out: string[] = [];
  for (let d = from; d <= end && out.length < ANALYTICS_MAX_DAYS_PER_RUN; d = d.plus({ days: 1 })) {
    const iso = d.toISODate();
    if (iso !== null) out.push(iso);
  }
  return out;
}

/** Loads every owed day up to yesterday (local). Advances the watermark after each day. */
export async function exportOwedDays(
  ctx: WorkerContext,
  sink: FactSink,
  now: Date,
): Promise<AnalyticsReport> {
  const yesterday = DateTime.fromJSDate(now, { zone: FACT_ZONE }).minus({ days: 1 }).toISODate();
  if (yesterday === null) throw new NaaradhError('INTERNAL', 'analytics: invalid clock');
  const watermark = await ctx.redis.get(ANALYTICS_WATERMARK);
  const days = daysOwed(watermark, yesterday);
  let rows = 0;
  const done: string[] = [];
  for (const day of days) {
    const facts = await dailyCallFacts(ctx.service, day);
    await sink.loadDay(day, facts);
    // Only after the load succeeded: a failure leaves the watermark on the last good day.
    await ctx.redis.set(ANALYTICS_WATERMARK, day);
    rows += facts.length;
    done.push(day);
    ctx.log.info({ day, rows: facts.length }, 'analytics: day loaded');
  }
  return { days: done, rows };
}

/**
 * The nightly trigger: after 01:30 local, once per local day, whichever instance takes the lock.
 * Returns null when there was nothing to do. A failed export releases the lock so the next tick
 * retries (with the loop's backoff), still on the same day.
 */
export async function runAnalyticsOnce(
  ctx: WorkerContext,
  sink: FactSink,
  now: Date,
): Promise<AnalyticsReport | null> {
  const local = DateTime.fromJSDate(now, { zone: FACT_ZONE });
  if (local.hour * 60 + local.minute < ANALYTICS_LOCAL_HOUR * 60 + ANALYTICS_LOCAL_MINUTE)
    return null;
  const today = local.toISODate();
  if (today === null) return null;
  const doneKey = `${ANALYTICS_LOCK}:${today}`;
  if ((await ctx.redis.exists(doneKey)) === 1) return null;
  const got = await ctx.redis.set(ANALYTICS_LOCK, ctx.workerId, 'EX', 50 * 60, 'NX');
  if (got !== 'OK') return null;
  try {
    const report = await exportOwedDays(ctx, sink, now);
    await ctx.redis.set(doneKey, ctx.workerId, 'EX', 36 * 3600);
    ctx.log.info({ days: report.days.length, rows: report.rows }, 'analytics: export done');
    return report;
  } finally {
    await ctx.redis.del(ANALYTICS_LOCK);
  }
}

export async function runAnalytics(
  ctx: WorkerContext,
  sink: FactSink,
  pollMs: number,
  signal: AbortSignal,
): Promise<void> {
  await runLoop({
    name: 'analytics',
    log: ctx.log,
    intervalMs: pollMs,
    signal,
    async tick() {
      await runAnalyticsOnce(ctx, sink, ctx.clock.now());
    },
  });
}
