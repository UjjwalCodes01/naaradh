import { runMigrations } from './migrate.js';

/**
 * `pnpm db:migrate`. Kept apart from migrate.ts so that bundling runMigrations() into a service
 * can never turn that service into a migration runner (an "am I the entry file?" check is true
 * for a single-file bundle).
 */
const url = process.env['DATABASE_MIGRATOR_URL'];
if (url === undefined) {
  console.error('DATABASE_MIGRATOR_URL is required (direct, non-pooled, owner role).');
  process.exit(2);
}
if (/-pooler\./.test(url)) {
  console.error('DATABASE_MIGRATOR_URL looks like a Neon POOLED endpoint. Use the direct one.');
  process.exit(2);
}
await runMigrations(url);
console.log('migrations applied');
