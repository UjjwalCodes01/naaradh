import { isoWeekOf, sampleWeeklyQa, type QaSampleReport } from '@naaradh/pipeline';
import type { WorkerContext } from '../context.js';

/**
 * Weekly QA sample (P4-OPS-1, ADR-0010 §11). Rides on the reconcile role: the first reconcile
 * tick of each ISO week (Monday 00:00 UTC onwards) samples the previous week, whichever instance
 * gets there first (Redis NX). The sampler itself is idempotent per tenant-week, so a retry after
 * a crash — or a missed Monday — never produces a second, different sample.
 */
export async function runQaWeekly(ctx: WorkerContext, now: Date): Promise<QaSampleReport | null> {
  const key = `qa-sample:${isoWeekOf(now)}`;
  const got = await ctx.redis.set(key, ctx.workerId, 'EX', 8 * 24 * 3600, 'NX');
  if (got !== 'OK') return null;
  try {
    return await sampleWeeklyQa(ctx.service, now);
  } catch (error) {
    await ctx.redis.del(key);
    throw error;
  }
}
