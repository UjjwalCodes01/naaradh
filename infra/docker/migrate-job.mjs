// Entrypoint of the Cloud Run Job `migrate` (infra/main.tf, docs/runbooks/deploy.md).
//
// Bundled by apps/workers/Dockerfile into /app/dist/migrate.js with tsup (config next to this
// file); the SQL lives in /app/migrations, which is where runMigrations() looks relative to the
// bundle (`<dist>/../migrations`). Runs with DATABASE_MIGRATOR_URL — the DIRECT Neon endpoint,
// owner role (ADR-0004) — which is mounted into this job and nothing else.
//
// This file owns the "run it" decision. packages/db/src/migrate.ts only exports runMigrations();
// the local CLI lives in migrate-cli.ts, so no bundle that imports it ever runs migrations.
import { runMigrations } from '../../packages/db/src/migrate.ts';

const url = process.env['DATABASE_MIGRATOR_URL'];
if (url === undefined || url.length === 0) {
  console.error('DATABASE_MIGRATOR_URL is required (direct, non-pooled, owner role).');
  process.exit(2);
}
if (/-pooler\./.test(url)) {
  console.error('DATABASE_MIGRATOR_URL looks like a Neon POOLED endpoint. Use the direct one.');
  process.exit(2);
}

await runMigrations(url);
console.log('migrations applied');
