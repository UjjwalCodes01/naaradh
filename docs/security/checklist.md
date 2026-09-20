# Security and compliance checklist — SPEC §14, with evidence

P3-INF-1. One row per item of `docs/NAARADH_BUILD_SPEC.md` §14. **Status** is what is true today
(14 Sep 2026): `built` = code/Terraform exists and is tested; `applied` = live in an environment;
`human` = an account, a document or a decision only a person can produce. Nothing has been applied
to Google Cloud yet (Phase 0 bootstrap is pending), so no item is `applied`. Re-tick this table
after the first stage apply and again before the first production call.

| # | Item (SPEC §14) | Status | Evidence | Remaining |
|---|---|---|---|---|
| 1 | MFA enforced for all staff GCP/GitHub/Shopify Partner/registrar accounts | human | — | Workspace 2SV enforcement (go-live 06 §1); GitHub org 2FA requirement; Partner account 2FA (go-live 04 §1); registrar |
| 2 | No long-lived service-account keys; WIF for CI | built | `infra/modules/iam` (Workload Identity Federation, `deployer`, read-only `tf-planner`); `deploy.yml` uses `id-token: write` | Org policy `iam.disableServiceAccountKeyCreation` at bootstrap (infra/README "Bootstrap") |
| 3 | Cloud SQL private IP + SSL + PITR + HA; Redis private IP | built (Neon instead of Cloud SQL, ADR-0004) | Neon: TLS required, IP allow-list = Cloud NAT static IPs (`infra/modules/network`), history retention for PITR (`runbooks/neon-bootstrap.md`); Redis on private services access with AUTH (`infra/modules/redis`) | Neon plan with ≥ 7-day history in prod; Q-16 (region) |
| 4 | CMEK on recordings bucket; uniform access; no public buckets | built | `infra/modules/gcs` (CMEK `recordings` key, UBLA, public access prevention); `modules/audit-logs` same for the audit bucket; org policy `storage.publicAccessPrevention` | apply |
| 5 | Secrets in Secret Manager; rotation runbook | built | `infra/modules/secrets` (containers + per-secret accessor from the key-holder map, `locals.tf` guards); `runbooks/secret-rotation.md`; re-encryption jobs `workers/src/maintenance/*` with `test/int/rotation.test.ts` | First rotation on staging (P3-INF-2 table) |
| 6 | HMAC verification on every inbound webhook; 401 on failure; replay window | built | Shopify: `hooks/src/routes/shopify.ts` + `test/int/hooks.test.ts` (401, raw-bytes); engine: adapter `parseWebhook` + tag; Razorpay: `routes/razorpay.ts`; merchant-facing webhooks signed with timestamp + `WEBHOOK_REPLAY_WINDOW_SEC` (`shared/src/signing.ts`) | — |
| 7 | RLS on all tenant tables; integration test proving cross-tenant reads fail | built | migrations `0001`, `0004`, `0007`–`0010` (FORCE RLS, policies per table); `db/test/int/rls.test.ts`; app-role privilege tests in `pipeline/test/int` | — |
| 8 | Phone numbers hashed for lookup, encrypted for dial; never in logs | built | `shared/src/phone.ts` (keyed hash, RSA-OAEP), key-holder map (private key only in dispatcher/results/reconcile), `logger.ts` redaction, `pnpm lint:pii` in CI | — |
| 9 | Log exclusions for PII; recording URLs never logged | built | `shared/src/logger.ts` redact paths; recordings referenced by `gs://` URI and served via 15-min signed URLs after an audited access (`accessMedia`) | Cloud Logging exclusion filter for `jsonPayload.recording_url` at apply (belt and braces) |
| 10 | Cloud Armor WAF + rate limits; per-key API limits | built | `infra/modules/armor` (per-host policies, WAF in preview first), `api/src/auth.ts` (per-key rate limit + daily cap), `voice`/`hooks` rate limits; client IP from `TRUST_PROXY_HOPS` (audit 2026-09-14: `trustProxy: true` was spoofable) | Enforce WAF after reviewing preview hits (infra/README); verify the hop count on stage |
| 11 | Dependency scanning (Dependabot), container scanning (Artifact Registry), SAST in CI | built | `.github/dependabot.yml` (npm, actions, docker, terraform); trivy on every image in `ci.yml`; CodeQL `.github/workflows/codeql.yml`; gitleaks | Enable Dependabot security updates + code scanning in repository settings |
| 12 | Backups tested by restore drill; DR runbook written | built | `runbooks/restore-drill.md`, `scripts/restore-drill.sh`, log `docs/security/restore-drills.md` | First drill on staging (needs the Neon project) |
| 13 | Data retention jobs running; deletion verified end-to-end (recording, transcript, ledger, BQ) | built | `workers/src/retention` + `test/int/compliance.test.ts` (erasure across tenants, media deleted, retention sweep); ledger rows are kept as legal records by design; BigQuery export holds no per-subject data (`analytics/facts.ts`, tested) | Verify on staging with the real GCS bucket |
| 14 | `security.txt`, vulnerability disclosure page | built | `web/src/app/.well-known/security.txt/route.ts`; `/security` page (`web/src/content/legal.ts`) | Bump `Expires` yearly |
| 15 | Access review process (quarterly) | human | `runbooks/on-call.md` weekly/quarterly items; IAP members and key-holder map are in Terraform (reviewable diffs) | First review; record in this file |
| 16 | Incident response plan + on-call rota | built (plan) / human (rota) | `runbooks/on-call.md`; alert channels `infra/modules/monitoring` (email + PagerDuty/webhook) | Fill the rota; PagerDuty or Better Stack account; status page |
| 17 | Privacy policy, DPA, AUP, ToS published and versioned | human | Drafts with version stamps in `web/src/content/legal.ts` (marked "pending counsel") | Lawyer review (P3-LEG-1), then remove the draft flag |
| 18 | Shopify Level 2 protected data approval granted | human | `docs/shopify/pcd-justification.md` ready | Submit after 17 (go-live 04 §7) |
| 19 | DLT telemarketer registration active; PE linkage flow working | built (flow) / human (registration) | Console: tenant DLT card (`console/src/routes/merchants.ts`), gate blocks promotional without `dlt_linked_at` | Registration needs the entity + GST (go-live 02 §3) |
| 20 | TSP written confirmation of CLI series for service calls on file `[OPEN]` | human | Q-01 open; `numbers.purpose_allowed` has no code default; console requires an evidence note per number | Send Appendix A letters (go-live 02 §1) |
| 21 | Do-not-call self-service page live and tested | built | `web` `/do-not-call`, `pipeline/src/public-dnc.ts`, API + tests | Live on the web app after apply |
| 22 | Complaint counters and auto-pause tested with synthetic complaints | built | `workers/test/int/compliance.test.ts` (3 in 10 days → pause; 5 → global kill), console tests | Staging demonstration with synthetic data (Phase 2 exit) |
| 23 | AI + recording disclosure verified in every language script and logged per call | built | `call-scripts` validator + `DISCLOSURES` per locale; DB trigger (invariant 7) refuses a human-answered attempt without both timestamps; compliance suite | Lawyer's wording per language (TODO_LEGAL in templates) |
| 24 | Calling-window enforcement tested at boundaries (08:59, 09:00, 20:59, 21:00 IST) | built | `compliance/test/regression/gate.transactional-window.test.ts`, `billable-retry-window.test.ts` | — |
| 25 | Spend caps tested (tenant, engine, global) | built | `compliance/test/regression/gate.tenant-caps-number.test.ts`, billing capped/frozen tests (`workers/test/int/billing.test.ts`) | — |
| 26 | Kill switches tested (global, tenant, campaign, engine) | built | compliance regression suite, console tests, Redis 5-s cache | — |
| 27 | Load test: 500 webhooks in 60 s; 50 concurrent calls in staging with engine simulator | built (scripts) | `load/*.js`, `.github/workflows/load.yml`, `runbooks/load-test.md`; chaos `workers/test/int/chaos.test.ts` | Run against staging once it exists; record results here |

## Access reviews

| Date | Scope | Reviewer | Findings |
|---|---|---|---|
| — | GCP IAM, IAP members, key-holder map, GitHub org, Shopify Partner staff, Neon members | — | not yet run |
