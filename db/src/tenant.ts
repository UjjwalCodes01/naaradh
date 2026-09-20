import { sql } from 'drizzle-orm';
import { isId, NaaradhError, type PrefixedId } from '@naaradh/shared';
import type { Db, Tx } from './client.js';

export type TenantId = PrefixedId<'tenant'>;

/**
 * Run `fn` inside a transaction whose RLS context is `tenantId` (invariant 15).
 *
 * `set_config(name, value, is_local = true)` scopes the setting to THIS transaction — which is
 * the only safe scope under Neon's PgBouncer (transaction pooling): a session-level SET would
 * survive on the server connection and be inherited by whichever tenant's transaction lands
 * on it next. The value is passed as a bind parameter, never interpolated.
 *
 * Every policy calls `app_tenant_id()`, which raises if the setting is absent, empty, or not a
 * `ten_<ulid>` — so forgetting this wrapper is an error, never a silent empty result.
 */
export async function withTenant<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!isId('tenant', tenantId)) {
    throw new NaaradhError('VALIDATION_FAILED', 'withTenant requires a tenant id', {
      context: { got_prefix: tenantId.slice(0, 4) },
    });
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * Reads the tenant context back from Postgres. Useful in repositories that must never run
 * without one — call it and let it throw rather than trusting a JS variable.
 */
export async function currentTenantId(tx: Tx): Promise<TenantId> {
  const result = await tx.execute<{ tenant_id: string }>(sql`select app_tenant_id() as tenant_id`);
  const row = result.rows[0];
  if (row === undefined || !isId('tenant', row.tenant_id)) {
    throw new NaaradhError('INTERNAL', 'app_tenant_id() returned no tenant');
  }
  return row.tenant_id;
}
