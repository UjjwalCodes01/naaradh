import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Workspace packages are source-only (their exports point at .ts), so they must be
  // bundled in rather than left as runtime imports Node cannot resolve.
  noExternal: [/^@naaradh\//],
  // Every OTHER node_modules import stays a runtime import — including the transitive deps of
  // the workspace packages (pg, pino, ulid, libphonenumber-js…). Without this, esbuild inlines
  // those CJS packages into the ESM bundle and the process dies at boot on
  // `Dynamic require of "events" is not supported`. The image's flattened prod node_modules
  // provides them (apps/*/Dockerfile, infra/docker/check-imports.mjs verifies).
  skipNodeModulesBundle: true,
});
