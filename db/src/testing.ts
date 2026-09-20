import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from './migrate.js';

/**
 * A throwaway Postgres 16 with the SAME bootstrap as docker-compose (roles, default
 * privileges, extensions) and all migrations applied. Integration tests get one per file.
 *
 * Three URLs, three roles — because a test that "proves RLS works" while connected as the
 * owner proves nothing.
 */
export interface TestPostgres {
  urls: { migrator: string; app: string; service: string };
  stop: () => Promise<void>;
  /**
   * Chaos tests: what a failover looks like from a client — every open connection is terminated
   * by the server ("terminating connection due to administrator command"). A container restart
   * would change the mapped port, which no real failover does.
   */
  disconnectAll: () => Promise<void>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const INIT_SQL = join(
  HERE,
  '..',
  '..',
  'docker',
  'postgres',
  'init',
  '00-roles-and-extensions.sql',
);

export async function startTestPostgres(): Promise<TestPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('naaradh_dev')
    .withUsername('naaradh_migrator')
    .withPassword('local_dev_only')
    .withCopyFilesToContainer([
      { source: INIT_SQL, target: '/docker-entrypoint-initdb.d/00-roles-and-extensions.sql' },
    ])
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = (role: string) =>
    `postgres://${role}:local_dev_only@${host}:${String(port)}/naaradh_dev`;

  const urls = {
    migrator: url('naaradh_migrator'),
    app: url('naaradh_app'),
    service: url('naaradh_service'),
  };
  await runMigrations(urls.migrator);

  return {
    urls,
    stop: () => container.stop().then(() => undefined),
    async disconnectAll() {
      const admin = new pg.Client({ connectionString: urls.migrator });
      await admin.connect();
      try {
        await admin.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where pid <> pg_backend_pid() and backend_type = 'client backend'`,
        );
      } finally {
        await admin.end();
      }
    },
  };
}

/** Small raw-SQL helper for tests: one pool per role, `inTenant` mirrors withTenant() exactly. */
export class RoleClient {
  private readonly pool: pg.Pool;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 2 });
    // Chaos tests terminate connections on purpose; an idle client's error must not crash vitest.
    this.pool.on('error', () => undefined);
  }

  query<R extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, params);
  }

  async inTenant<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}
