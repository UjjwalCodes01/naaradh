import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either a database or a transaction — repositories accept both. */
export type DbOrTx = Db | Tx;

export interface CreateDbOptions {
  /** Pooled Neon endpoint (or local docker) as naaradh_app / naaradh_service. */
  url: string;
  /** Neon's pooled endpoint tops out per plan; Cloud Run instances × this must fit (ADR-0004). */
  max?: number;
  applicationName?: string;
}

/**
 * Connection factory. One pool per process; callers get a Drizzle handle.
 *
 * Every tenant-scoped query MUST go through `withTenant()` (tenant.ts). A bare `db.select()`
 * against a tenant table raises `app.tenant_id is not set` from inside Postgres — by design.
 */
export function createDb(options: CreateDbOptions): {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
} {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.max ?? 5,
    application_name: options.applicationName ?? 'naaradh',
    // Fail fast rather than queue forever if the pooler is saturated.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // A single slow statement should not hold a pooled connection indefinitely.
    statement_timeout: 30_000,
  });

  // Timezone is UTC by `ALTER DATABASE ... SET timezone` in the bootstrap (docker init /
  // docs/runbooks/neon-bootstrap.md), not by a per-connection SET: a connect-hook query races
  // the first real query under node-postgres, and PgBouncer may drop startup options anyway.
  // packages/db/test/int/rls.test.ts asserts the database setting.

  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

/** Liveness probe helper for /readyz. */
export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
