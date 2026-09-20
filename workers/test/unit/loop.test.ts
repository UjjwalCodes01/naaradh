import { describe, expect, it } from 'vitest';
import type { Logger } from '@naaradh/shared';
import {
  LOOP_RECOVERED_LOG,
  LOOP_UNHEALTHY_AFTER,
  LOOP_UNHEALTHY_LOG,
  runLoop,
} from '../../src/loop.js';

/**
 * The loop helper every worker runs on (P3-INF-4): a failing tick backs off instead of ending
 * the loop, the fifth consecutive failure logs the line Cloud Monitoring pages on, recovery is
 * logged once, `true` from a tick re-runs immediately, and abort stops promptly mid-backoff.
 */

interface Line {
  level: 'info' | 'warn' | 'error';
  msg: string;
  fields: Record<string, unknown>;
}

function fakeLogger(): { lines: Line[]; log: Logger } {
  const lines: Line[] = [];
  const push =
    (level: Line['level']) =>
    (fields: unknown, msg?: string): void => {
      lines.push({
        level,
        msg: msg ?? (typeof fields === 'string' ? fields : ''),
        fields:
          typeof fields === 'object' && fields !== null ? (fields as Record<string, unknown>) : {},
      });
    };
  const log = {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('info'),
    fatal: push('error'),
    trace: push('info'),
    child: () => log,
  } as unknown as Logger;
  return { lines, log };
}

describe('runLoop', () => {
  it('survives failing ticks, pages after five in a row, and logs recovery once', async () => {
    const { lines, log } = fakeLogger();
    const controller = new AbortController();
    let n = 0;
    const loop = runLoop({
      name: 'chaos',
      log,
      intervalMs: 1,
      signal: controller.signal,
      backoffBaseMs: 1,
      async tick() {
        n += 1;
        if (n <= LOOP_UNHEALTHY_AFTER + 1) throw new Error('db away');
        if (n === LOOP_UNHEALTHY_AFTER + 4) controller.abort();
        return undefined;
      },
    });
    await loop;
    const errors = lines.filter((l) => l.level === 'error');
    expect(errors.length).toBe(LOOP_UNHEALTHY_AFTER + 1);
    expect(errors.map((l) => l.msg)).toEqual([
      'chaos pass failed',
      'chaos pass failed',
      'chaos pass failed',
      'chaos pass failed',
      LOOP_UNHEALTHY_LOG,
      'chaos pass failed',
    ]);
    expect(errors[4]?.fields['consecutive_failures']).toBe(LOOP_UNHEALTHY_AFTER);
    // Backoff doubles from the base and is reported with each failure.
    expect(errors.map((l) => l.fields['backoff_ms'])).toEqual([1, 2, 4, 8, 16, 32]);
    expect(lines.filter((l) => l.msg === LOOP_RECOVERED_LOG).length).toBe(1);
    expect(n).toBe(LOOP_UNHEALTHY_AFTER + 4);
  });

  it('re-runs immediately when a tick returns true and stops on abort during the wait', async () => {
    const { log } = fakeLogger();
    const controller = new AbortController();
    const ticks: number[] = [];
    const started = Date.now();
    const loop = runLoop({
      name: 'fast',
      log,
      intervalMs: 60_000,
      signal: controller.signal,
      async tick() {
        ticks.push(Date.now() - started);
        if (ticks.length < 3) return true; // batch was full: again, now
        setTimeout(() => {
          controller.abort();
        }, 20); // then wait 60 s… but abort cuts it short
        return false;
      },
    });
    await loop;
    expect(ticks.length).toBe(3);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('never ticks once the signal is already aborted', async () => {
    const { log } = fakeLogger();
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    await runLoop({
      name: 'noop',
      log,
      intervalMs: 1,
      signal: controller.signal,
      async tick() {
        ran = true;
      },
    });
    expect(ran).toBe(false);
  });
});
