import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit reads the schema and writes SQL migrations to ./migrations. It never talks to a
 * database from CI; `migrate` (src/migrate.ts) applies the folder with the DIRECT (non-pooled)
 * migrator connection — see ADR-0004.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  strict: true,
  verbose: true,
  dbCredentials: {
    url:
      process.env['DATABASE_MIGRATOR_URL'] ??
      'postgres://naaradh_migrator:local_dev_only@localhost:55432/naaradh_dev',
  },
});
