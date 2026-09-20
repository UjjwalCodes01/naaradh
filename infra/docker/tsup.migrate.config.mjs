// tsup config for the migrate job bundle (workers/Dockerfile). Run from the repo root:
//   workers/node_modules/.bin/tsup --config infra/docker/tsup.migrate.config.mjs   → dist/migrate/migrate.js
// Same shape as */tsup.config.ts: source is bundled, node_modules (pg, drizzle-orm) stay
// runtime imports resolved from the image's production node_modules.
export default {
  entry: { migrate: 'infra/docker/migrate-job.mjs' },
  outDir: 'dist/migrate',
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@naaradh\//],
  skipNodeModulesBundle: true,
};
