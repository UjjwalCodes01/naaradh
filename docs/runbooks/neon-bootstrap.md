# Neon bootstrap

One-time setup of a Neon project so that `pnpm db:migrate` and the application roles work
exactly as they do against the local Docker Postgres (`docker/postgres/init`). ADR-0004.

Do this once per environment (dev, stage, prod-in). Nothing here is applied by code; a human runs
it in the Neon SQL editor or `psql` against the **direct** endpoint as the project's default role.

## 1. Project

- Postgres **16** (matches local and CI; do not pick 17 for one environment only).
- Region: `aws-ap-southeast-1` (Singapore) — nearest to Mumbai; India is not offered. Q-16.
- Production: enable PITR/history retention **≥ 7 days** (SPEC §6.10 RPO), autosuspend **off**
  for the production compute (the dispatcher SLO cannot absorb a cold start), and a compute
  size with enough connections for `Cloud Run instances × 5`.

## 2. Roles

Neon's default role is the owner (call it `naaradh_owner`; it plays the part `naaradh_migrator`
plays locally). Create the two application roles with generated passwords — store them in Secret
Manager, never in a `.env` file that leaves a laptop.

```sql
-- as naaradh_owner, on the DIRECT endpoint
CREATE ROLE naaradh_app     WITH LOGIN PASSWORD '<generated>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
CREATE ROLE naaradh_service WITH LOGIN PASSWORD '<generated>' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS   NOINHERIT;

GRANT CONNECT ON DATABASE naaradh TO naaradh_app, naaradh_service;
GRANT USAGE   ON SCHEMA public   TO naaradh_app, naaradh_service;

-- Same default privileges as docker/postgres/init: append-only unless a migration says otherwise.
ALTER DEFAULT PRIVILEGES FOR ROLE naaradh_owner IN SCHEMA public GRANT SELECT, INSERT   ON TABLES    TO naaradh_app, naaradh_service;
ALTER DEFAULT PRIVILEGES FOR ROLE naaradh_owner IN SCHEMA public GRANT USAGE, SELECT    ON SEQUENCES TO naaradh_app, naaradh_service;
ALTER DEFAULT PRIVILEGES FOR ROLE naaradh_owner IN SCHEMA public GRANT EXECUTE          ON FUNCTIONS TO naaradh_app, naaradh_service;

ALTER DATABASE naaradh SET timezone TO 'UTC';
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
```

`[VERIFY]` `BYPASSRLS` is grantable by the Neon owner role (it is `neon_superuser`-adjacent; if
refused, open a Neon support ticket — the service role cannot function without it and the
workaround of running cross-tenant jobs as owner is **not acceptable**, the owner bypasses the
append-only triggers only if it deliberately disables them, but it also owns everything).

## 3. Connection strings

| Secret | Endpoint | Role | Used by |
|---|---|---|---|
| `DATABASE_MIGRATOR_URL` | **direct** (`…neon.tech`) | `naaradh_owner` | `pnpm db:migrate` (Cloud Run Job), drizzle-kit |
| `DATABASE_URL` | **pooled** (`…-pooler.…neon.tech`) | `naaradh_app` | api, shopify, tenant-scoped workers |
| `DATABASE_SERVICE_URL` | **pooled** | `naaradh_service` | hooks, reconcile, retention, billing-meter, complaints |

Always `?sslmode=require`. `src/migrate.ts` refuses a URL containing `-pooler.` for migrations.

## 4. Apply migrations

```bash
DATABASE_MIGRATOR_URL='postgres://naaradh_owner:…@ep-….neon.tech/naaradh?sslmode=require' pnpm db:migrate
```

## 5. Verify (do not skip)

Run `db/test/int/rls.test.ts`'s checks by hand against the new environment, as
`naaradh_app`:

```sql
SELECT count(*) FROM tenants;                  -- must ERROR: app.tenant_id is not set
BEGIN; SELECT set_config('app.tenant_id','ten_00000000000000000000000000',true); SELECT count(*) FROM tenants; COMMIT;  -- 0, no error
SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity AND NOT c.relforcerowsecurity;  -- must be empty
```

## 6. Branches

Preview branches (per PR) are created from `dev` and get the same roles automatically (roles are
project-wide). Never branch from `prod-in`: a branch is a copy of production data.
