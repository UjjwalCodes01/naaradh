import { defineConfig } from 'vitest/config';

/**
 * `pnpm test:int` — integration tests against real Postgres 16 and Redis 7 via Testcontainers.
 * Requires Docker. Longer timeouts because containers start per suite; single-threaded so
 * suites do not fight over the same database.
 *
 * passWithNoTests is true until P1-CORE-1 lands the schema.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['*/test/int/**/*.test.ts', 'engines/*/test/int/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    passWithNoTests: true,
    restoreMocks: true,
  },
});
