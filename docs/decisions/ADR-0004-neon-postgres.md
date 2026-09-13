# ADR-0004 — Neon as the managed Postgres

**Status:** accepted
**Date:** 2026-09-12
**Deciders:** Founder
**Invariants touched:** 15 (RLS tenant isolation — mechanism refined, not weakened); data residency (SPEC §6.1) — **changed, see Consequences**
**Open questions closed:** none. Opens Q-16.

## Context

SPEC §6.3 chose Cloud SQL for PostgreSQL 16 (HA, private IP, PITR, CMEK) in `asia-south1`. The
founder has chosen **Neon** instead — serverless Postgres with branching, scale-to-zero and a
built-in connection pooler — to remove the ₹20–30k/month fixed cost and the private-networking
setup from the critical path while the product is pre-revenue.

## Decision

Neon is the system of record for every environment. Concretely:

1. **Postgres 16** on Neon, matching the local `docker-compose.yml`, so behaviour is identical in
   Testcontainers, on a laptop and in production.
2. **Two connection strings per environment.**
   `DATABASE_URL` is the **pooled** endpoint (PgBouncer, transaction mode) used by every runtime
   service as the `naaradh_app` role. `DATABASE_MIGRATOR_URL` is the **direct** endpoint used only
   by `drizzle-kit`/`migrate()` as the owner role. Migrations must not run through PgBouncer.
3. **Tenant context is set per transaction with `set_config(..., true)`**, never with session
   `SET`. Under transaction-mode pooling a session-level setting can leak to the next tenant's
   query on the same server connection; a transaction-local one cannot.
4. **Role split is unchanged from the local bootstrap:** owner/migrator, `naaradh_app`
   (`NOBYPASSRLS`, non-owner), and `naaradh_service` (`BYPASSRLS`, used only by the workers that
   genuinely scan across tenants: reconcile, retention, billing-meter, complaints). Neon lets
   `neon_superuser` create these via SQL; `docs/runbooks/neon-bootstrap.md` has the script.
5. **IDs are prefixed ULIDs stored as `text`** (`ten_…`, `int_…`), per CLAUDE.md, not the `uuid`
   the SPEC's illustrative DDL used. RLS therefore cannot rely on a `::uuid` cast to fail loudly
   when the tenant setting is empty. Every policy instead calls `app_tenant_id()`, a function
   that **raises** if the setting is missing, empty, or malformed. Silent zero-row results — the
   failure mode that lets a suppressed number through — are impossible by construction.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Cloud SQL (SPEC) | India region, private IP, CMEK, one cloud | ~$250–350/mo fixed; VPC connector + NAT work before first query; slower iteration |
| **Neon** | Branch-per-PR, scale-to-zero, pooler included, cheap while small, plain Postgres | **No India region today**; SSL over public internet to Cloud Run; egress cost from GCP to AWS; another vendor in the DPA sub-processor list |
| Supabase | India region unavailable too; bundles auth we don't want | Same residency gap; heavier |
| Self-managed on GCE | India region, full control | Ops burden the plan explicitly avoids |

## Consequences

- **Data residency `[VERIFY]` `[LEGAL]`.** Neon's regions (AWS/Azure: US, EU, Singapore, São
  Paulo at time of writing) do not include India. The nearest is **`aws-ap-southeast-1`
  (Singapore)**, and that is what the project uses. SPEC §4.1.3 and §6.1 set India-residency as a
  *default* under a `[DECISION]` tag, not a legal finding; DPDP permits transfer to any country not
  on a government-notified blocklist (none notified as of this ADR). Three things follow:
  1. Recordings and transcripts stay in GCS `asia-south1` — the DB holds hashes, encrypted numbers,
     metadata and extracted outcomes, not audio. Row data is still personal data.
  2. The privacy policy, DPA and sub-processor page must name Neon and Singapore. `[LEGAL]`
  3. **Q-16** (new): does an Indian merchant's DPA or a Shopify Level 2 review require in-country
     storage for call metadata? If yes, the migration path is `pg_dump` → Cloud SQL Mumbai; the
     schema, roles and migrations in `packages/db` are plain Postgres and move unchanged.
- **Encryption:** Neon encrypts at rest with provider-managed keys; CMEK is not available. The
  app-level RSA-OAEP encryption of dialable numbers (`packages/shared/src/phone.ts`) is therefore
  the control that matters — a DB export alone yields no phone numbers.
- **Availability:** Neon HA/PITR is per-plan; PITR retention must be set to ≥ 7 days on the
  production project to keep SPEC §6.10's RPO. `docs/runbooks/restore-drill.md` targets Neon's
  branch-from-timestamp restore.
- **Connections:** Cloud Run instances × pool size must stay under the pooled-endpoint limit; each
  service pool is capped at 5 (`packages/db/src/client.ts`).
- **Latency:** Mumbai → Singapore adds ~35–50 ms per round trip. The gate is designed to make few
  queries (batched reads, Redis for counters); the dispatcher SLO (intent → dial p95 < 90 s) has
  ample room.

## Rollback

Everything is vanilla Postgres 16. `pg_dump --no-owner` from Neon → restore into Cloud SQL Mumbai
→ re-run `docs/runbooks/neon-bootstrap.md` role script (it is Cloud-SQL-compatible) → swap the two
connection strings. Nothing becomes unrecoverable; only the Neon branches (dev/preview) are lost.
