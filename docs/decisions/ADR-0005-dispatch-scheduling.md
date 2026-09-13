# ADR-0005 — Dispatch scheduling: Postgres queue with `SKIP LOCKED`, not Cloud Tasks

**Status:** accepted
**Date:** 2026-09-12
**Deciders:** Founder (implemented by agent, per PLAN P1-CORE-6)
**Invariants touched:** 10 (idempotency — strengthened: one row, one lock), 12 (kill switches unchanged)
**Open questions closed:** none

## Context

SPEC §6.3 and AGENTS §5.1 step 7 schedule each intent as a Cloud Task named by the
idempotency key, to be delivered at `not_before`, and cancel by deleting the task. That design
has three costs for a two-person team:

1. **No local parity.** Cloud Tasks has no emulator. Every dispatcher test would mock the
   scheduler, so the one path that actually dials would be the least tested.
2. **Two sources of truth.** `call_intents.status` and the task queue can disagree (task fires
   after a cancellation; task lost after a create) and the reconcile job exists largely to
   re-align them.
3. **Retry scheduling needs a second task per retry**, each named, each cancellable.

## Decision

The `call_intents` table **is** the queue.

- An intent is due when `status IN ('SCHEDULED','RETRY_SCHEDULED') AND next_attempt_at <= now()`
  (`next_attempt_at = not_before` on creation).
- The dispatcher is an always-on Cloud Run service (min 1 instance) that claims due intents with
  `SELECT … FOR UPDATE SKIP LOCKED LIMIT n` in priority order (`priority DESC, next_attempt_at ASC`),
  as the **service role** (the claim is cross-tenant), then processes each one **inside
  `withTenant()`** as the app role. Claim and process are two transactions: the claim flips the
  row to `DISPATCHING` with a `claimed_at`; the reconcile job returns rows stuck in
  `DISPATCHING` for > 2 minutes to `SCHEDULED` (crash recovery).
- Cancellation, gating, retry and expiry are all `UPDATE`s of the same row. There is nothing
  else to delete.
- Poll interval 1 s when idle, immediate when the last batch was full. `intent → dial p95 < 90 s`
  (SPEC §6.8) has a whole order of magnitude of headroom.
- Cloud Scheduler still triggers the cron-shaped jobs (reconcile, retention, billing rollups).
  Cloud Tasks may return later for fan-out work (webhook deliveries at scale); nothing here
  forecloses it.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Cloud Tasks (SPEC) | Managed retries, exact-time delivery, no polling | No emulator; two sources of truth; per-retry task management; cancellation by name |
| **Postgres `SKIP LOCKED`** | One source of truth; identical locally, in CI and in prod; trivially cancellable; visible in SQL | Polling; dispatcher must stay warm; horizontal scale bounded by Postgres row locks (fine to ~10k intents/min) |
| Pub/Sub with delayed delivery | Managed | No native delay beyond ack deadlines; would need a timer table anyway |

## Consequences

- `call_intents` gains `next_attempt_at`, `claimed_at`, `claimed_by` semantics and a partial index
  on the due predicate (migration 0002).
- The dispatcher needs the service role for the claim query only; everything after the claim runs
  as the app role in the tenant's context — the same invariant-15 discipline as before, with the
  cross-tenant surface reduced to one `UPDATE … RETURNING`.
- E-48 (uninstall ≤ 60 s): setting `tenants.status = 'paused'` is enough; the gate refuses at
  step 1 on the next claim, and a bulk `UPDATE call_intents SET status='CANCELLED'` clears the queue.
- Testcontainers can exercise the real dispatcher end-to-end with the simulator engine.

## Rollback

Add a Cloud Tasks scheduler behind the same `Scheduler` interface; the table columns remain
useful as the record of what was scheduled.
