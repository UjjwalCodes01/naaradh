# Phase 2 review — Shopify app + compliance layer + dashboard

**Date:** 13 Sep 2026 · **Verdict:** code-complete and tested locally; **live exit criteria not met**
(they need a Partner app, a dev store, an engine and the entity — the same external items as
Phase 1). Built under the founder sequencing note recorded in `phase-1.md`: live criteria are
**deferred, not waived**.

## Exit criteria

| Criterion | Status | Evidence |
|---|---|---|
| A new dev store installs the app and places a live test call within 10 minutes, no engineer help | **Deferred** — no Partner app, dev store or engine | Install provisioning (`provision_shopify_install`, tested incl. concurrent first loads and reinstall), onboarding checklist + go-live guard in `apps/shopify`; test call needs an engine (P0-ENG) |
| Billing round-trip on a dev store (subscription + usage record + capped pause) | Built; live deferred | Shopify Billing operations against a fake Admin endpoint (`packages/shopify-sdk/test/billing.test.ts`); postings, capped/frozen, reconciliation (`apps/workers/test/int/billing.test.ts`); approval flow `apps/shopify/app/routes/app.billing.tsx` |
| Mandatory compliance webhooks pass Shopify's automated checks; bad HMAC → 401 | 401 proven; automated check deferred | `apps/hooks/test/int/hooks.test.ts`; topics declared in `apps/shopify/shopify.app.toml` |
| DNC page, erasure, retention, complaint auto-pause demonstrated with synthetic data | **Met locally**; staging deferred (infra not applied) | `apps/workers/test/int/compliance.test.ts`, `apps/api/test/int/api.test.ts`, `/do-not-call` page smoke-tested, staff console tests |
| Client A migrated from the custom app to the public app | **Deferred** — needs the public Partner app | — |
| Level 2 protected customer data request submitted | Ready; submission is a human step | `docs/shopify/pcd-justification.md` |

Test totals at review: unit 168 · compliance 170 · contracts 29 · integration 185 (11 suites) ·
build 7/7 (api, hooks, voice, workers, console, web, shopify) · typecheck, lint, lint:pii,
format ✓ · `terraform validate` ✓ (nothing applied).

## Tickets

| Ticket | Status |
|---|---|
| P2-LEG-1 DLT telemarketer registration | human — needs the entity (P0-LEG) |
| P2-LEG-2 PE guide + linkage | PE id field and promotional guard done; the merchant guide is open |
| P2-CMP-1…4 | done (P2-CMP-2 page shipped with `apps/web`) |
| P2-SHOP-1, 3, 4, 5 | done |
| P2-SHOP-2 onboarding | done except the test call and voice choice (need an engine) |
| P2-SHOP-6 Level 2 request | document ready; submission human |
| P2-SHOP-7 Flow trigger | **open** — needs a Flow extension (and a Partner app to register it) |
| P2-SHOP-8 staging Partner app + dev-store matrix | human |
| P2-WEB-1, 3, 4 | done |
| P2-WEB-2 RTO analytics | in-app counts done; BigQuery export + baseline **open** |
| P2-BILL-1…3 | done |
| P2-INF-1 | done (Terraform) |
| P2-INF-2 | dataset/table in Terraform; export job **open** |
| P2-OPS-1 runbooks | done except `cli-health.md` (needs a CLI pool) |
| P2-OPS-2 alerting | partial — log-based alerts and uptime checks in `infra/modules/monitoring` |
| P1-API-3 `naaradh.js` (carried) | done |
| P1-INF-1 Terraform (carried) | done — validate only; apply is a human step |

## What was built

- **Compliance layer:** complaint intake queue with attribution and auto-pause/global kill,
  public do-not-call (API + page), erasure across tenants, retention sweep (migration 0007).
- **Billing (ADR-0008):** plan catalogue with allowances, `billing_postings` outbox to Shopify
  usage records and Razorpay add-ons, capped/frozen handling, disputes with credit rows, nightly
  reconciliation and margin alert (migration 0008).
- **Merchant dashboard (`apps/web`, ADR-0009):** magic-link sign-in, roles, orders and support
  calls explained in plain language, tickets, knowledge base, support agent, scripts, privacy,
  billing, team, API keys, access log; public site, pricing from the billing catalogue, legal
  drafts, do-not-call page, `naaradh.js`.
- **Shopify app (`apps/shopify`, ADR-0007/0009):** React Router template, sessions sealed in
  Postgres through definer functions, install provisioning, onboarding, script approval,
  support-line setup, Billing API approval.
- **Staff console (`apps/console`):** complaints, tenant resume/suspend, disputes, kill switches,
  global erasure/DNC, behind IAP.
- **Workers:** notifications (alerts + daily summary), hourly Shopify order reconcile (E-53),
  expiring offline-token refresh, Admin session deleted on uninstall.
- **Shared domain layer:** admin operations moved out of the API into `@naaradh/pipeline` so the
  API, dashboard and Shopify app enforce the same rules and write the same audit rows.
- **Infra:** Terraform (13 modules, key-holder guard as plan preconditions), Dockerfiles for all
  seven services, CI image builds, deploy workflow (stage auto, prod by protected dispatch).

## Decisions taken in this phase

ADR-0007 (Shopify app template, tokens in Postgres), ADR-0008 (billing), ADR-0009 (merchant
surfaces). New open question: **Q-20** (stores outside India). Deliberate deviations recorded in
ADR-0009: number "reveal" deferred until a KMS decrypt exists; `write_customers` scope not
requested until Q-07 is answered; dashboard built without shadcn/ui (a small Tailwind component
set instead).

## Risks carried forward

- Every live criterion in Phases 1 and 2 waits on the same external items (entity/GST, engine
  bake-off, numbers, Partner app). They should be re-run together as the first live milestone.
- Legal pages are drafts; Level 2 approval, App Store review and Q-16 (database region) depend on
  counsel.
- The embedded app has not been exercised against a real dev store (App Bridge session tokens,
  expiring-token refresh, billing approval redirect). P2-SHOP-8 is where that happens.
- Disk space on the development machine ran out during this phase; container image builds for
  hooks, voice and workers were not verified locally (CI builds them).
