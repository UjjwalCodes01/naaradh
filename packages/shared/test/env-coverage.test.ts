import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `pnpm env:check` (scripts/env-template.mjs) in CI: every service can boot from what `infra/`
 * gives it, `.env.example` and `apps/web/.env.example` list exactly the variables the schemas
 * accept, and no committed template carries a credential.
 *
 * A new required variable that nothing sets is a service that will not start on the next deploy;
 * this is where that is caught, not in the Cloud Run logs.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('environment coverage', () => {
  it('every service could boot from infra/, and the templates match the schemas', () => {
    let output: string;
    try {
      output = execFileSync(
        process.execPath,
        ['--import', 'tsx', join(ROOT, 'scripts/env-template.mjs'), '--check'],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      throw new Error(`pnpm env:check failed:\n${e.stderr ?? ''}${e.stdout ?? ''}`);
    }
    expect(output).toContain('every service can boot');
  }, 60_000);
});
