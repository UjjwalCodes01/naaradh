import { defineConfig } from 'vitest/config';

/**
 * `pnpm test:compliance` — the compliance regression suite.
 *
 * This is the gate that must pass before any merge (CLAUDE.md). A failure here means either
 * the code is wrong, or the test encodes a rule change that needs a decision record in
 * docs/decisions/. It never means "weaken the gate to make the test pass".
 *
 * passWithNoTests is false on purpose: an empty compliance suite reporting green is worse
 * than a red one.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/compliance/test/regression/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: false,
    restoreMocks: true,
  },
});
