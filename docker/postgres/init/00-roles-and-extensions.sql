-- Local Postgres bootstrap. Runs once, on an empty data directory.
--
-- The point of this file is to make CLAUDE.md invariant 15 ("tenant isolation is enforced by
-- Postgres RLS, not only by WHERE tenant_id = ?") testable locally, because RLS has two
-- silent bypasses that make a passing test meaningless:
--
--   1. A table's OWNER bypasses its own RLS policies unless the table is declared
--      FORCE ROW LEVEL SECURITY.
--   2. Superusers and any role with BYPASSRLS ignore policies entirely.
--
-- So we split the roles: migrations run as the owner, the application connects as a
-- non-owner role that can never bypass. An integration test that proves cross-tenant reads
-- fail is only meaningful when it runs as naaradh_app.

-- naaradh_migrator is the initdb superuser (POSTGRES_USER) and owns the schema.
-- Migrations and drizzle-kit use it. Never use it as an application connection.

CREATE ROLE naaradh_app WITH
  LOGIN
  PASSWORD 'local_dev_only'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS
  NOINHERIT;

COMMENT ON ROLE naaradh_app IS
  'Application connection role. Non-owner, NOBYPASSRLS: every tenant query is subject to RLS. Workers set app.tenant_id per transaction.';

-- The cross-tenant door (ADR-0004, db/src/service.ts). BYPASSRLS, but still bound
-- by table grants, so it cannot mutate append-only tables either. Used only by the hooks
-- service and the workers that genuinely scan every tenant.
CREATE ROLE naaradh_service WITH
  LOGIN
  PASSWORD 'local_dev_only'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  BYPASSRLS
  NOINHERIT;

COMMENT ON ROLE naaradh_service IS
  'Cross-tenant role for hooks/reconcile/retention/billing-meter/complaints. BYPASSRLS; never used to serve a merchant request.';

GRANT CONNECT ON DATABASE naaradh_dev TO naaradh_app, naaradh_service;
GRANT USAGE ON SCHEMA public TO naaradh_app, naaradh_service;

-- Default grants are SELECT + INSERT only, deliberately.
--
-- AGENTS.md section 4 makes several tables append-only (consents, suppressions history,
-- audit_log, billing_ledger, webhook_events) — corrections there are new rows, never edits.
-- Making append-only the DEFAULT means a migration has to opt a table INTO mutability with
-- an explicit GRANT UPDATE, DELETE, rather than a reviewer having to notice a missing REVOKE.
ALTER DEFAULT PRIVILEGES FOR ROLE naaradh_migrator IN SCHEMA public
  GRANT SELECT, INSERT ON TABLES TO naaradh_app, naaradh_service;

ALTER DEFAULT PRIVILEGES FOR ROLE naaradh_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO naaradh_app, naaradh_service;

ALTER DEFAULT PRIVILEGES FOR ROLE naaradh_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO naaradh_app, naaradh_service;

-- Store UTC, always (CLAUDE.md: timestamptz in UTC; windows computed with luxon in the
-- recipient's IANA zone). A local server in IST would hide timezone bugs that surface in prod.
ALTER DATABASE naaradh_dev SET timezone TO 'UTC';

-- gen_random_uuid() for tenant ids and digest()/hmac() for phone_hash experiments.
-- Production phone hashing happens in the application with PHONE_HASH_KEY, not in SQL.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
