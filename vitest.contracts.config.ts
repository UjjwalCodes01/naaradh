import { defineConfig } from 'vitest/config';

/**
 * `pnpm test:contracts` — engine adapter contract tests.
 *
 * Every adapter runs the same shared harness (packages/engines/harness) against its own
 * recorded, sanitised vendor payloads. The 13 scenarios are listed in AGENTS.md section 10:
 * answered-human-confirmed, answered-machine, no-answer, busy, transfer-success,
 * transfer-fail, opt-out mid-call, webhook-duplicate, webhook-out-of-order, webhook-missing
 * (poll path), unsigned-webhook (re-fetch path), 429 backoff, 5xx circuit-open.
 *
 * passWithNoTests is true until P1-ENG-1 lands the harness.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/engines/**/contract.test.ts', 'packages/engines/**/test/contract.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
    restoreMocks: true,
  },
});
