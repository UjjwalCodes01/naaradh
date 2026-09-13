/**
 * The cross-tenant door. Import ONLY from the workers that genuinely scan every tenant:
 * reconcile (stuck attempts), retention, billing-meter, complaints (global counter), and the
 * hooks service (which writes webhook_events before a tenant is known).
 *
 * `naaradh_service` has BYPASSRLS. Nothing that serves a merchant request — api, dashboard,
 * the Shopify app — may use it; eslint's no-restricted-imports enforces that outside
 * apps/workers and apps/hooks. Every use is a deliberate, reviewed exception to invariant 15.
 */
import { createDb, type CreateDbOptions, type Db } from './client.js';

export interface ServiceDb {
  db: Db;
  close: () => Promise<void>;
}

export function createServiceDb(options: CreateDbOptions): ServiceDb {
  const { db, close } = createDb({
    ...options,
    applicationName: options.applicationName ?? 'naaradh-service',
  });
  return { db, close };
}
