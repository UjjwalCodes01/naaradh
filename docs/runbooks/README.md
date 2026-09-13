# Runbooks

Written for whoever is on call at 2 a.m. — symptom first, then the exact commands, then how to verify it worked. No architecture explanations.

`AGENTS.md §13` owns this list. A behaviour change that requires an operator to act is not done until its runbook is updated (`CLAUDE.md` definition of done).

| Runbook | Purpose | Due |
|---|---|---|
| [`kill-switch.md`](kill-switch.md) | Flip global / engine / tenant / campaign kill switches; audit expectations | done |
| [`engine-outage.md`](engine-outage.md) | Circuit breaker, failover flag, merchant comms | done |
| [`stuck-attempts.md`](stuck-attempts.md) | Stuck-attempt poller, manual reconcile, concurrency-counter repair | done |
| [`neon-bootstrap.md`](neon-bootstrap.md) | One-time Neon project/role setup (ADR-0004) | done |
| [`inbound-fallback.md`](inbound-fallback.md) | Callers forwarded or hearing the closed message: admission reasons, leaked inbound slots, staff-key mismatch (ADR-0006) | done |
| [`shopify-writeback.md`](shopify-writeback.md) | Outcomes stuck `failed` on the Shopify write-back: retry vs give-up, reconnecting a store, re-queueing | done |
| [`agent-action-failed.md`](agent-action-failed.md) | A caller-confirmed cancellation did not reach the store: actions worker, retries, hand-over tickets | done |
| [`complaint-received.md`](complaint-received.md) | Intake, attribution, tenant pause, global kill, TRAI response `[LEGAL]` | done |
| [`erasure-request.md`](erasure-request.md) | DPDP / Shopify `redact` flow, what is erased and kept, failures, verification | done |
| [`merchant-access.md`](merchant-access.md) | Dashboard sign-in problems, removing a person, account takeover, merchant emails not arriving | done |
| [`staff-console.md`](staff-console.md) | The IAP staff console: access, which page for which situation, rules | done |
| [`billing-dispute.md`](billing-dispute.md) | Evidence bundle, accept/reject, credit row, Shopify manual refund | done |
| [`billing-postings.md`](billing-postings.md) | Postings to Shopify/Razorpay, capped / frozen tenants, reconciliation deltas, margin alert | done |
| [`deploy.md`](deploy.md) | Deploy (stage/prod), roll back a revision, plan → review → apply Terraform, add a secret version, run migrations, dead letters | done |
| `cli-health.md` | Answer-rate monitoring, CLI rotation, retirement below 25% | P2-OPS-1 |
| `shopify-api-upgrade.md` | Quarterly API version bump checklist | P3-OPS-2 |
| `restore-drill.md` | Quarterly Cloud SQL restore test | P3-OPS-2 |
