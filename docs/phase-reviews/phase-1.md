# Phase 1 review — Core pipeline + first live calls (incl. Phase 1B inbound)

**Date:** 12 Sep 2026 · **Verdict:** code-complete on the simulator; **live exit criteria not met** (blocked on external items, by founder decision). Proceeding to Phase 2 under the recorded decision below.

PLAN.md ("Definition of phase complete") requires every exit criterion to carry evidence, kill criteria to be evaluated, and any skipped gate to carry a written founder decision in this file. That is what follows.

## Founder decision — proceeding without the live gate

> **11 Sep 2026 (sequencing note, PLAN.md) and 12 Sep 2026 (this review):** build first, paperwork after. No call to a real customer happens until the entity, an eKYC'd number and a bake-off-selected engine exist (SPEC §3.2). Phase 2 is built on the simulator in the meantime. Phase 1's live exit criteria are **deferred, not waived**: they are re-run as the first milestone once P0-LEG-1/2 (entity, GST), P0-ENG-1…6 (bake-off, ADR-0001) and a number are in place.

## Exit criteria

| Criterion | Status | Evidence |
|---|---|---|
| Client A: ≥ 200 real COD confirmation calls inside the 30-minute window | **Deferred** — no engine/number/entity | — |
| Zero calls outside 09:00–21:00 IST (proven by query) | Enforced in code; live proof deferred | Gate step 7 + boundary tests at 08:59/09:00/20:59/21:00 IST and `+29m59s`/`+30m01s` in `packages/compliance/test/regression` (170 tests green) |
| Extraction validated by human review ≥ 90% | **Deferred** — needs real calls | Extraction schemas validated with Zod; invalid → `inconclusive` (results tests) |
| Client B: lead-callback live; merchant webhook delivered and verified | Built; live deferred | `apps/api/test/int/api.test.ts` (24), signed deliveries in `apps/workers/test/int/e2e.test.ts` |
| Every attempt has `ai_disclosed_at` + `recording_disclosed_at`; recordings in GCS; no raw phone in logs | Enforced | Disclosure guard in finalize (missing → `FAILED` + incident); E-34 recording persistence tested; `pnpm lint:pii` clean; logger redaction |
| Compliance regression suite green in CI; contract tests green for simulator + chosen engine | Simulator green; chosen engine deferred | `pnpm test:compliance` 170 ✓; `pnpm test:contracts` 29 ✓ (outbound + inbound suites) |
| **1B:** end-to-end inbound suite on the simulator | **Met** | `apps/voice/test/int/voice.test.ts` — 25 tests through voice + hooks + results on Postgres + Redis |
| **1B:** live pilot ≥ 2 weeks, ≥ 300 calls, ≥ 50% resolved, zero disclosure to unverified callers, tool p95 < 700 ms | **Deferred** | — |

Test totals at review: unit 137 · compliance 170 · contracts 29 · integration 123 · build ✓ · typecheck/lint/lint:pii/format ✓.

## Tickets

| Ticket | Status |
|---|---|
| P1-CORE-1…9 | done |
| P1-ENG-1, 2, 4 | done |
| P1-ENG-3 vendor adapter | **blocked** — ADR-0001 (bake-off) |
| P1-API-1, 2 | done |
| P1-API-3 `naaradh.js` snippet | carried into Phase 2 work package 0 (buildable) |
| P1-API-4 Client B wired live | deferred (live) |
| P1-SHOP-1 custom-app mirror | done (hooks + intents-consumer + gateway table) |
| P1-SHOP-2 write-backs | done — live dev-store smoke test pending |
| P1-SHOP-3 Client A pilot | deferred (live) |
| P1-INF-1 Terraform | carried into Phase 2 work package 7 (buildable; apply is a human step) |
| P1-INF-2 CI | done (deploy step pending INF-1) |
| P1-INF-3 logging/alerts | logging done; alert policies carried into WP7 |
| P1-OPS-1 runbooks | done |
| P1-OPS-2 internal admin page | carried into Phase 2 (staff console in `apps/web`) |
| P1B-INB-1…6, CORE-1…3, API-1, OPS-1 | done |
| P1B-ENG-1 | blocked — ADR-0001 |
| P1B-OPS-2 latency dashboard | carried into WP7 (monitoring module) |

## Kill / pivot criteria

Not evaluable: every kill criterion in Phase 1 and 1B (answer rate < 35%, extraction disagreement > 15%, abandon rate during tools > 25%, merchants refusing to forward numbers) is measured on live calls. **Re-evaluate at the deferred live milestone.**

## Phase 2 entry criteria

- "Phase 1 exit" — not met; proceeding under the decision above.
- "DLT telemarketer application submitted (P2-LEG-1)" — not started (needs GST). Phase 2 code that depends on DLT (promotional use cases, template registration) ships disabled behind the existing gates.
