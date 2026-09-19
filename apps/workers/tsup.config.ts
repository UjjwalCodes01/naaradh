import { defineConfig } from 'tsup';

export default defineConfig({
  // dist/index.js is the long-running worker; the rest are one-shot maintenance entrypoints
  // (docs/runbooks/secret-rotation.md) shipped in the same image: `node dist/rotate-….js`.
  entry: {
    index: 'src/index.ts',
    'rotate-shopify-token-key': 'src/maintenance/rotate-shopify-token-key.ts',
    'rotate-phone-enc-key': 'src/maintenance/rotate-phone-enc-key.ts',
    'rotate-staff-enc-key': 'src/maintenance/rotate-staff-enc-key.ts',
    'dnc-load': 'src/maintenance/dnc-load.ts',
  },
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
