import type { WorkerContext } from '../context.js';
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

/** Always-on loop (ADR-0005): immediate when the batch was full, else poll. */
export async function runDispatcher(
  ctx: WorkerContext,
  pollMs: number,
  signal: AbortSignal,
): Promise<void> {
  ctx.log.info({ worker: ctx.workerId, poll_ms: pollMs }, 'dispatcher started');
  while (!signal.aborted) {
    const outcomes = await dispatchOnce(ctx);
    if (outcomes.length < ctx.dispatchBatch) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
  ctx.log.info('dispatcher stopped');
}
