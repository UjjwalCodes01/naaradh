import type { Logger } from '@naaradh/shared';

/**
 * The one way a worker loop runs (P3-INF-4 hardening). A tick that throws — Postgres restarting,
 * Redis failing over, an engine timing out — is logged and retried with exponential backoff
 * (1 s doubling to LOOP_BACKOFF_MAX_MS); it never kills the loop, which would leave a process
 * idling behind a green health check. After LOOP_UNHEALTHY_AFTER consecutive failures the loop
 * logs `worker loop unhealthy` at error level — Cloud Monitoring pages on that exact substring
 * (infra/main.tf `log_alerts.loop_unhealthy`) — and `worker loop recovered` once a tick succeeds.
 *
 * A tick may return `true` to ask for an immediate re-run (the dispatcher when its batch was
 * full, ADR-0005); anything else waits `intervalMs`. Aborting the signal ends the loop promptly,
 * including from inside a backoff wait.
 */

export const LOOP_UNHEALTHY_AFTER = 5;
export const LOOP_BACKOFF_MAX_MS = 30_000;
export const LOOP_UNHEALTHY_LOG = 'worker loop unhealthy';
export const LOOP_RECOVERED_LOG = 'worker loop recovered';

export interface LoopOptions {
  readonly name: string;
  readonly log: Logger;
  readonly intervalMs: number;
  readonly signal: AbortSignal;
  /** One iteration. Resolving to `true` re-runs immediately; anything else waits. */
  readonly tick: () => Promise<unknown>;
  /** Test hook: the base backoff after the first failure (default 1 s). */
  readonly backoffBaseMs?: number;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function runLoop(options: LoopOptions): Promise<void> {
  const { name, log, signal } = options;
  const base = options.backoffBaseMs ?? 1_000;
  let failures = 0;
  log.info({ loop: name, interval_ms: options.intervalMs }, `${name} loop started`);
  while (!signal.aborted) {
    let again = false;
    try {
      again = (await options.tick()) === true;
      if (failures >= LOOP_UNHEALTHY_AFTER)
        log.warn({ loop: name, consecutive_failures: failures }, LOOP_RECOVERED_LOG);
      failures = 0;
    } catch (error) {
      failures += 1;
      const backoff = Math.min(base * 2 ** (failures - 1), LOOP_BACKOFF_MAX_MS);
      const fields = {
        loop: name,
        consecutive_failures: failures,
        backoff_ms: backoff,
        err: error,
      };
      if (failures === LOOP_UNHEALTHY_AFTER) log.error(fields, LOOP_UNHEALTHY_LOG);
      else log.error(fields, `${name} pass failed`);
      await sleep(backoff, signal);
      continue;
    }
    if (!again) await sleep(options.intervalMs, signal);
  }
  log.info({ loop: name }, `${name} loop stopped`);
}
