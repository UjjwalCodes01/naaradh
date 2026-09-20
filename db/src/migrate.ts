import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDb } from './client.js';

/**
 * Applies ./migrations with the DIRECT migrator connection (owner role). Run as a Cloud Run
 * Job before each deploy (SPEC §6.9), never through the pooled endpoint (ADR-0004), never as
 * naaradh_app.
 */
export async function runMigrations(url: string): Promise<void> {
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const { db, close } = createDb({ url, max: 1, applicationName: 'naaradh-migrate' });
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}
