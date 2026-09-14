import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SIMULATOR_DEV_SECRET, engineEnv, refineEngineEnv } from '../src/index.js';

/**
 * The simulator never rings a phone, so a production service configured with it silently places
 * no calls; and its development webhook secret is public in the repo. Both are refused in
 * production unless a staging-like environment says so explicitly.
 */
const schema = z
  .object({ NODE_ENV: z.enum(['development', 'test', 'production']), ...engineEnv })
  .superRefine(refineEngineEnv);

const issues = (env: Record<string, string>) => {
  const r = schema.safeParse(env);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('refineEngineEnv', () => {
  it('development and test accept the simulator with the shared secret', () => {
    expect(issues({ NODE_ENV: 'development' })).toEqual([]);
    expect(issues({ NODE_ENV: 'test', ENGINE_DEFAULT_IN: 'simulator' })).toEqual([]);
  });

  it('production refuses the simulator unless SIMULATOR_ALLOWED=true, and never the dev secret', () => {
    expect(issues({ NODE_ENV: 'production' })).toEqual([
      'ENGINE_DEFAULT_IN',
      'SIMULATOR_WEBHOOK_SECRET',
    ]);
    expect(
      issues({
        NODE_ENV: 'production',
        ENGINE_SECONDARY_IN: 'simulator',
        ENGINE_DEFAULT_IN: 'bolna',
        ENGINE_DEFAULT_US: 'retell',
      }),
    ).toEqual(['ENGINE_DEFAULT_IN', 'SIMULATOR_WEBHOOK_SECRET']);
    expect(
      issues({
        NODE_ENV: 'production',
        SIMULATOR_ALLOWED: 'true',
        SIMULATOR_WEBHOOK_SECRET: SIMULATOR_DEV_SECRET,
      }),
    ).toEqual(['SIMULATOR_WEBHOOK_SECRET']);
    expect(
      issues({
        NODE_ENV: 'production',
        SIMULATOR_ALLOWED: 'true',
        SIMULATOR_WEBHOOK_SECRET: 'x'.repeat(40),
      }),
    ).toEqual([]);
  });

  it('production with real engines needs neither', () => {
    expect(
      issues({ NODE_ENV: 'production', ENGINE_DEFAULT_IN: 'bolna', ENGINE_DEFAULT_US: 'retell' }),
    ).toEqual([]);
  });
});
