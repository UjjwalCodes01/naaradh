# On-call

**Who:** one person at a time, named in the rota below, phone on and charged; a backup who can be reached within 30 minutes. A single-person company is still a rota: the founder is primary, the backup is whoever can flip a kill switch (staff console access) — even if that is a contractor with only that permission.

## Where alerts come from

| Source | Reaches you by | Configured in |
|---|---|---|
| Cloud Monitoring policies (uptime, SLOs, log matches, error rates, backlog, Redis) | Email (every severity); PagerDuty and/or webhook (CRITICAL only) | `infra/modules/monitoring`, `alert_email` + `TF_VAR_pagerduty_service_key` / `TF_VAR_alert_webhook_url` |
| Merchant email to support@ | Shared inbox | Google Workspace |
| TRAI / TSP complaint | Email to the registered address (complaint-received.md) | DLT registration |
| Shopify (app review, API deprecations, partner emails) | Partner account email | Partner Dashboard |
| Vendor status pages (engine, Neon, Google Cloud) | Subscribe by email | each vendor |

## Severities

| Severity | Meaning | Response | Examples |
|---|---|---|---|
| **CRITICAL** | Calls have stopped or a compliance invariant is at risk | Page; act within 15 minutes, any hour | uptime check failing, voice p95 > 700 ms, 5xx > 2 %, global kill switch tripped, complaint auto-pause, dead letters growing |
| **ERROR** | Something is broken but callers and merchants are served | Same day, working hours | hooks p99 > 800 ms, worker loop unhealthy, Pub/Sub backlog, sustained error logs, erasure overdue |
| **WARNING** | Needs attention this week | Weekly review | Redis memory, CLI answer rate, margin alert, reconciliation delta |

## First 15 minutes (CRITICAL)

1. Acknowledge the page. Open the alert's runbook link (every policy names one).
2. Is anyone being harmed? Runaway calling, calls outside the window, wrong recipients → **global kill switch** first (`kill-switch.md`), ask questions after. Post to `status.naaradh.com`.
3. Did a deploy just happen? Actions → deploy → the last run. Roll back (`deploy.md` §3) before diagnosing.
4. Check the basics in order: `/healthz` and `/readyz` of api, hooks, voice; Neon status page; Redis memory; the engine's status page (`engine-outage.md`).
5. Write what you see in the incident channel as you go (timestamps). The incident review needs it.

## Escalation

| Problem | Who |
|---|---|
| Engine down or degraded | Vendor support (contract's emergency contact) — `engine-outage.md` |
| Database | Neon support (plan's support channel); `restore-drill.md` for recovery |
| Telecom / number blocked | The CPaaS account manager; `cli-health.md` |
| Legal / regulatory contact (TRAI, DPDP request, police) | The lawyer — never answer alone; `complaint-received.md`, `erasure-request.md` |
| Security incident (leak, breach) | Rotate what leaked (`secret-rotation.md`), preserve logs (audit bucket is write-once), lawyer for notification duties (Q-06) |

## After

- Incident review within 3 working days: timeline, impact (calls affected, merchants, money), root cause, fixes as issues.
- Status page: post the resolution.
- If a runbook was missing or wrong, fix it in the same PR as the fix.

## Weekly review (Monday, 30 minutes) — PLAN cross-phase tracks

- Complaint log (console → Complaints).
- Recording QA sample (2 % of calls, rubric in P4-OPS-1; until then: 10 calls).
- CLI health (console → Numbers; `cli-health.md`).
- Open alerts and their trend; dead letters (`deploy.md` "Dead letters").
- Billing reconciliation delta and margin (`billing-postings.md`).
- `docs/open-questions.md`.

## Rota

| From | To | Primary | Backup | Notes |
|---|---|---|---|---|
| launch | — | founder | — | fill in before the first live call (P3-OPS-1) |
