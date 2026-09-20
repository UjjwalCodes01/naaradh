# @naaradh/db

Drizzle schema, forward-only migrations, RLS policies, seed data and typed queries.
System of record: Cloud SQL Postgres 16. Mirrors SPEC §6.5.

**Status:** not implemented — ticket **P1-CORE-1**.

## Rules every migration must follow

1. **One migration per PR, forward-only.** Down-migration notes go in the PR description, not in code.
2. **Every tenant-scoped table gets its RLS policy in the same migration** (invariant 15):
   `USING (tenant_id = current_setting('app.tenant_id')::uuid)`. A table without a policy is a
   cross-tenant data leak waiting for one bad `WHERE` clause.

   **Use exactly that form — never `current_setting('app.tenant_id', true)`.** The `missing_ok`
   variant makes a query with no tenant context return *zero rows silently*. For most tables that
   is merely a confusing bug; for `suppressions` and `consents` it is a compliance failure: a worker
   that forgot `withTenant()` gets "no suppression found" and the gate lets the call through. The
   strict form raises instead — verified against the local Postgres 16:

   | Situation | `current_setting('app.tenant_id')` | `…, true)` |
   |---|---|---|
   | never set in this session | `ERROR: unrecognized configuration parameter` | 0 rows, silently |
   | pooled connection, a previous txn used `SET LOCAL` | `ERROR: invalid input syntax for type uuid: ""` | 0 rows, silently |

   The second row is the one that bites in production: after a `SET LOCAL` transaction ends, the
   setting lingers on the pooled connection as an empty string.
3. **Add `FORCE ROW LEVEL SECURITY`** — without it the table owner silently bypasses its own policies,
   and the migrator role owns everything.
4. **Append-only tables get no `UPDATE`/`DELETE` grant**: `consents`, `suppressions` history,
   `audit_log`, `billing_ledger`, `webhook_events`. Corrections are new rows. The local bootstrap
   (`docker/postgres/init`) grants only `SELECT, INSERT` by default, so mutability is opt-in.
5. **Money is `bigint` paise/cents** with a currency code beside it. Never a float.
6. **Times are `timestamptz` in UTC.** Windows are computed in the recipient's IANA zone with luxon,
   never with `Date` arithmetic.
7. **New column that may hold PII** → add it to the logger redact list and to the erasure job in the
   same PR.
8. **New enum value that affects billing or gating** → ADR in `docs/decisions/`.

## Connection roles

| Role | Used by | Bypasses RLS? |
|---|---|---|
| `naaradh_migrator` | drizzle-kit migrations only; owns the schema | yes — never use as an app connection |
| `naaradh_app` | api, hooks, workers (`DATABASE_URL`) | **no** — `NOBYPASSRLS`, non-owner |

The integration test that proves cross-tenant reads fail must run as `naaradh_app`, or it proves nothing.
