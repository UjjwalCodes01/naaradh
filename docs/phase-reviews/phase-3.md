# Phase 3 review — Harden, legal, App Store submission

**Date:** 14 Sep 2026 · **Verdict:** the engineering half of Phase 3 is code-complete and tested
locally; the **exit criteria are not met** because every one of them needs something only a
person can produce — an applied Google Cloud environment, the entity, counsel, the Partner app.
Built under the founder's sequencing note ("paperwork in progress, proceed with the code"),
recorded in `phase-1.md`: live criteria are deferred, not waived.

## Exit criteria

| Criterion | Status | Evidence |
|---|---|---|
| SPEC §14 checklist 100% with evidence; load/chaos results within SLOs | **Partly** — 21 of 27 items `built` with evidence; 6 are `human` (MFA, access review, legal docs, Level 2, DLT, TSP letter); nothing `applied` yet | `docs/security/checklist.md`; k6 scripts + workflow ready, no staging to run them against; chaos test green (`apps/workers/test/int/chaos.test.ts`) |
| Legal docs live at their URLs and versioned; clickwrap in onboarding | **Deferred** — drafts are versioned and served, clickwrap exists (`MERCHANT_ATTESTATION`, version stamped); counsel review is P3-LEG-1 | `apps/web/src/content/legal.ts`, `packages/pipeline/src/billing/shopify-subscribe.ts` |
| App Store submission accepted into review | **Deferred** — needs the production Partner app, Level 2 and final legal pages | `docs/shopify/pre-submission-checklist.md` ready to run |
| ADR-0002 on CLI/DND written with sources attached | **Deferred** — needs the TSP letters (Q-01, Q-02) | `docs/open-questions.md` |

## Tickets

| Ticket | Status |
|---|---|
| P3-INF-1 §14 checklist | ◐ written with evidence; `applied`/`human` rows open |
| P3-INF-2 secret rotation | ◐ runbook, previous-key window, three re-encryption jobs (tested); first rotation on staging pending |
| P3-INF-3 restore drill | ◐ runbook + `scripts/restore-drill.sh` + log; first drill pending (Neon project) |
| P3-INF-4 load + chaos | ✅ k6 scripts, `load` workflow, runbook; chaos test; loop hardening (below) |
| P3-INF-5 audit logs | ✅ Terraform (validated, not applied) |
| P3-INF-6 scanning + security.txt | ✅ Dependabot, CodeQL, `/.well-known/security.txt` (+ trivy, gitleaks from before) |
| P3-INF-7 VPC-SC evaluation | ✅ `docs/security/vpc-service-controls.md` — defer |
| P3-LEG-1…4 | human (lawyer, CA, TSP letters) |
| P3-SHOP-1 listing | human |
| P3-SHOP-2 pre-submission checklist | ◐ document ready; the dev-store review needs the Partner app |
| P3-SHOP-3 submit | human |
| P3-OPS-1 on-call + alerting + status page | ◐ `on-call.md`, PagerDuty/webhook channels, SLO policies; rota names and status page are human |
| P3-OPS-2 runbooks | ✅ `shopify-api-upgrade.md`, `restore-drill.md`, `cli-health.md`, `load-test.md`, `on-call.md`, `secret-rotation.md` |
| P3-OPS-3 support desk | human |
| Carried from Phase 2: P2-INF-2 / P2-WEB-2 export | ✅ nightly BigQuery load (`workers-analytics`), no PII; baseline view still open |
| Carried from Phase 2: P2-SHOP-7 Flow trigger | open — needs the Partner app |
| Brought forward from Phase 4: P4-OPS-2 CLI health | ◐ nightly job + console page; retirement stays a staff decision |

## What was built

- **Staff console:** Numbers (register, purposes with the Q-01 evidence note, status transitions, owner + inbound profile), New merchant (direct tenants with owner, use cases OFF, draft scripts), the DLT principal-entity link on the tenant page. Closes three of the "gaps you will hit" from the go-live guide.
- **Worker hardening (chaos finding):** every loop now runs on `runLoop` (exponential backoff, `worker loop unhealthy` after five failures → alert), the dispatcher no longer dies on a failed claim, the Postgres pool has an error handler (an idle client terminated by the server used to be an uncaught exception), Redis client errors are logged.
- **Number health (E-28):** nightly `answer_rate_7d` per number from real dials, audit + alert on crossing 25%.
- **Key rotation:** previous-key keyring for Shopify sessions; `rotate-shopify-token-key`, `rotate-phone-enc-key`, `rotate-staff-enc-key` maintenance entrypoints in the workers image.
- **Analytics export:** `daily_call_facts` aggregation (invariant 11 billability, rounded-up inbound minutes, ledger amounts, IST day) loaded per partition with `WRITE_TRUNCATE`.
- **OpenAPI:** generated from the route schemas, served at `/v1/openapi.json`, committed to `docs/api/openapi.json`, drift-checked in CI, with a Client B quickstart.
- **Infra:** audit-logs module (Data Access logs, locked CMEK bucket, sink), monitoring channels + SLO/backlog policies, BigQuery grants moved to the analytics worker, a twelfth worker role.
- **Supply chain:** Dependabot, CodeQL, `security.txt`.
- **Docs:** security checklist with evidence, VPC-SC evaluation, pre-submission checklist, seven runbooks, go-live guide updated.

## Test totals at review

unit 177 (22 files) · compliance 170 · contracts 29 · integration 203 (15 suites, incl. chaos,
rotation, cli-health, analytics, console) · typecheck, lint, lint:pii, format ✓ · api/hooks/voice/
workers/console build ✓ (web/shopify images built in CI) · `terraform validate` ✓ (nothing applied).

## Audit

A full read-through after the phase (`docs/security/audit-2026-09-14.md`) found and fixed five
defects the tests had not caught: the simulator engine could run in production with the
repository's development secret, merchant webhook URLs were an SSRF, `trustProxy: true` made
client IPs spoofable, erasure left tool arguments behind, and the OpenAPI text overstated the
rate limit. Each now has a test or a boot-time refusal.

## Risks carried forward

- Nothing here has run on Google Cloud. The first stage apply will surface what only a real
  project shows (IAM propagation, the IAP audience two-step, Neon allow-list, Cloud Armor preview
  hits). Budget a week for it.
- The load thresholds are the spec's numbers, not measurements; the first staging run sets the
  real baseline.
- The Postgres pool error handler and the loop backoff were found by the chaos test in this phase;
  the same class of bug may exist in the Next.js and React Router apps' long-lived clients
  (they are request-scoped, so the blast radius is one request, but review before launch).
- `pincode_band` / `state` in the analytics export are null until the order cache stores a
  coarse band (a Phase 4 decision: what is coarse enough).
