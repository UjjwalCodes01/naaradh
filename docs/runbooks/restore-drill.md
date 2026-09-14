# Restore drill and point-in-time recovery (Neon)

**Trigger:** the quarterly drill (PLAN cross-phase track; log in `docs/security/restore-drills.md`), or a real need to recover — a bad migration, a destructive query, a corrupted table.

The database is Neon Postgres (ADR-0004), not Cloud SQL: there is no backup file to restore. Neon keeps a **history** of every branch and can create a new branch from any instant inside it. Recovery = branch from a timestamp, verify, then either copy rows back or point the services at the branch.

**Targets** `[VERIFY against the Neon plan]`: RPO ≤ 1 minute (history is continuous); RTO ≤ 30 minutes (branch creation is seconds; the time goes on verification and the secret roll). Production needs history retention ≥ 7 days (`neon-bootstrap.md`); stage 1 day.

Recordings and transcripts live in GCS with soft delete (`recordings_soft_delete_seconds` in tfvars) — object restore is a separate `gcloud storage restore` step, not covered by a database branch.

## The drill (quarterly, on stage first, then prod)

```bash
export NEON_API_KEY=…            # from the Neon console, a personal key; never commit it
export NEON_PROJECT_ID=…
scripts/restore-drill.sh "$(date -u -d '-1 hour' +%FT%TZ)"        # creates a branch at T-1h, verifies, deletes it
scripts/restore-drill.sh "$(date -u -d '-1 hour' +%FT%TZ)" --keep # keep the branch for a manual look
```

The script creates `drill-<timestamp>` from the primary branch at that instant, waits until it has a compute endpoint, runs the checks below with `psql` as the migrator role, prints a summary and deletes the branch (unless `--keep`). Record the run (date, timestamp, checks, wall-clock RTO, who) in `docs/security/restore-drills.md`.

Checks (all must pass):

- row counts of `tenants`, `call_attempts`, `audit_log` are plausible for that instant;
- newest `audit_log.at` is within a few minutes before the requested timestamp;
- `call_attempts` has row-level security enabled and forced;
- the latest migration in the drizzle migrations table matches the deployed one.

## A real recovery

1. **Stop writes**: flip the global kill switch (`kill-switch.md`) and scale the workers to zero if the damage is ongoing (`gcloud run services update workers-<role> --max-instances 0`).
2. Find the instant just before the damage (audit log, deploy time, the bad query's timestamp).
3. `scripts/restore-drill.sh <instant> --keep` → a verified branch.
4. Choose:
   - **Repair in place** (a few rows / one table): `pg_dump --data-only -t <table>` from the branch, review, load into the primary inside a transaction. Preferred — nothing else moves.
   - **Fail over to the branch** (the primary is unusable): in Neon, set the branch as the new primary (or repoint the roles), then add new secret versions of `DATABASE_URL`, `DATABASE_SERVICE_URL`, `DATABASE_MIGRATOR_URL` with the branch's pooled/direct hosts and roll every service (`deploy.md` §5). Writes made to the old primary after the instant are lost: reconcile the gap from `webhook_events` (Shopify redelivers) and the engines' call lists (reconcile's `fetchCall`).
5. Verify with the drill checks plus a smoke call on staging; lift the kill switch; write the incident up (`on-call.md`).

## Don'ts

- Never delete the old primary branch until the incident review is done.
- Never run the drill script against a production branch with `--keep` and forget it: a kept branch bills compute. `scripts/restore-drill.sh --list` shows drill branches.
