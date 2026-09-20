import type { WorkerContext } from '../context.js';
import { runLoop } from '../loop.js';
import { claimDueIntents } from './claim.js';
import { dispatchIntent, type DispatchOutcome } from './dispatch.js';

/** One pass: claim what is due, process each claim. Returns the outcomes for tests/metrics. */
export async function dispatchOnce(ctx: WorkerContext): Promise<DispatchOutcome[]> {
  const claimed = await claimDueIntents(
    ctx.service,
    ctx.workerId,
    ctx.clock.now(),
    ctx.dispatchBatch,
  );
  const outcomes: DispatchOutcome[] = [];
  for (const c of claimed) {
    try {
      outcomes.push(await dispatchIntent(ctx, c.id, c.tenant_id));
    } catch (error) {
      // A thrown error here means a bug, not a gate refusal: the claim stays DISPATCHING and
      // reconcile returns it to the queue in two minutes. Log loudly.
      ctx.log.error({ err: error, intent_id: c.id, tenant_id: c.tenant_id }, 'dispatch crashed');
    }
  }
  return outcomes;
}

/**
 * Always-on loop (ADR-0005): immediate when the batch was full, else poll. A failed claim
 * (database or Redis away) backs off and retries; it never ends the loop (see ../loop.ts).
 */
export async function runDispatcher(
  ctx: WorkerContext,
  pollMs: number,
  signal: AbortSignal,
): Promise<void> {
  await runLoop({
    name: 'dispatcher',
    log: ctx.log,
    intervalMs: pollMs,
    signal,
    async tick() {
      const outcomes = await dispatchOnce(ctx);
      return outcomes.length >= ctx.dispatchBatch;
    },
  });
}
