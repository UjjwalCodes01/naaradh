import { defineConfig } from 'vitest/config';

/**
 * `pnpm test` — unit tests. No Docker, no network, no clock dependence.
 * Integration (Testcontainers), compliance regression and engine contract suites have
 * their own configs so CI can gate on them separately.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['{apps,packages}/**/test/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/test/int/**',
      'packages/compliance/test/regression/**',
      '**/contract.test.ts',
    ],
    passWithNoTests: false,
    restoreMocks: true,
  },
});
