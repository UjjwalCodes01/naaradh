import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The business alerts (P2-OPS-2) match log **messages**, so those strings are an interface
 * between `infra/modules/monitoring/main.tf` and the workers. Renaming a message is a one-word
 * change that silently disarms an alert, and the failure is invisible: the alert simply never
 * fires again, which looks exactly like nothing going wrong.
 *
 * So every message a filter names must exist in the source, and the services those filters watch
 * must be services we actually deploy.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MONITORING = readFileSync(join(ROOT, 'infra/modules/monitoring/main.tf'), 'utf8');
const LOCALS = readFileSync(join(ROOT, 'infra/locals.tf'), 'utf8');

/** Just the business-metrics block: the infrastructure filters above it match on metrics, not text. */
const BUSINESS = MONITORING.slice(MONITORING.indexOf('business_metrics = {'));

function sourceOf(dir: string): string {
  let text = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) text += sourceOf(path);
    else if (entry.name.endsWith('.ts')) text += readFileSync(path, 'utf8');
  }
  return text;
}

const WORKERS_SOURCE = sourceOf(join(ROOT, 'workers/src'));

describe('business alert filters', () => {
  const messages = [...BUSINESS.matchAll(/jsonPayload\.message[:=]\\"([^"\\]+)\\"/g)].map(
    (m) => m[1] as string,
  );

  it('names at least the four events P2-OPS-2 asks for', () => {
    // complaint pause, operational gate, writeback give-up, capped subscription.
    expect(messages.length).toBeGreaterThanOrEqual(4);
  });

  it.each([...new Set(messages)])('the log message "%s" exists in the workers', (message) => {
    expect(WORKERS_SOURCE).toContain(message);
  });

  it('only watches services that are deployed', () => {
    const watched = [...BUSINESS.matchAll(/service_name[:=]\\"(workers-[a-z]+)\\"/g)].map(
      (m) => m[1] as string,
    );
    const roles = /worker_roles = \[([\s\S]*?)\]/.exec(LOCALS)?.[1] ?? '';
    const deployed = new Set(
      [...roles.matchAll(/"([a-z]+)"/g)].map((m) => `workers-${m[1] as string}`),
    );
    for (const service of watched) expect(deployed, service).toContain(service);
  });
});
