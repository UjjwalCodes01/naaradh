# 5. Cloud infrastructure (Google Cloud, domain, GitHub, Neon, deploys)

Everything runs on Google Cloud in `asia-south1` (Mumbai), described in Terraform under `infra/`.
The Terraform is written and `terraform validate` passes; **nothing has been applied**. Agents
write plans; **a human applies** (AGENTS §1). Day-to-day operations are in
`docs/runbooks/deploy.md`; this page is the one-time bootstrap in order.

## 1. Google Cloud organisation and projects (P0-INF-1)

1. **Cloud Identity / Workspace** on naaradh.com gives you a Google Cloud **organisation**
   ([06](06-email-and-payments.md#1-google-workspace)).
2. **Billing account** in the company's name with GST (1 day). Set a budget with alerts at
   50/90/100% per project.
3. Create the projects:

   | Project | Purpose |
   |---|---|
   | `naaradh-shared` | Cloud DNS zone for naaradh.com |
   | `naaradh-dev` | Development |
   | `naaradh-stage-in` | Staging — `main` deploys here automatically |
   | `naaradh-prod-in` | Production — manual, approved deploys |

4. **Org policies:** restrict resource locations to `asia-south1` / `asia-south2`; require CMEK
   for the recordings bucket (SPEC §6.2). Terraform assumes these.
5. Enable the APIs Terraform needs on each project (Run, Artifact Registry, Secret Manager, KMS,
   Pub/Sub, Memorystore, Compute, Certificate Manager, IAM Credentials, IAP, Monitoring,
   BigQuery). The first `terraform apply` tells you any it is missing.

## 2. Domain and DNS (P0-INF-2)

The domain is bought (PLAN Phase 0). At the registrar: registrar lock, 2FA, auto-renew, a second
admin contact; then point the nameservers to the **Cloud DNS** zone in `naaradh-shared`; enable
DNSSEC and publish the DS record `[VERIFY registrar support]`.

Hostnames the load balancer serves (SPEC §7.1; staging uses `*.stage.naaradh.com`):

| Host | Service |
|---|---|
| `naaradh.com`, `app.naaradh.com` | web (public site + dashboard) |
| `api.naaradh.com` | api |
| `hooks.naaradh.com` | hooks (Shopify, engine, Razorpay webhooks) |
| `voice.naaradh.com` | voice (engine inbound + tool calls) |
| `shopify.naaradh.com` | shopify (embedded app) |
| `console.naaradh.com` | console (IAP only) |
| `cdn.naaradh.com` | `naaradh.js` (served by web until a CDN is set up) |
| `mail.naaradh.com` | Postmark sending domain ([06](06-email-and-payments.md)) |

Certificates are Google-managed (Certificate Manager, DNS authorisation) and created by Terraform.
Add CAA records allowing `pki.goog`.

## 3. GitHub (P0-INF-5)

- Organisation `naaradh`, repository with branch protection on `main` (PR + review + green CI).
- Environments: `dev`, `stage`, `production` (production has required reviewers).
- Repository/environment **variables** the workflows read (values from `terraform output`):
  `GCP_PROJECT`, `GCP_REGION`, `GCP_ARTIFACT_REPOSITORY`, `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA`,
  `SMOKE_HOSTS` (hosts for the post-deploy health check), and **`DEPLOY_ENABLED=true`** — the
  deploy workflow does nothing until you set it. No long-lived keys: CI authenticates with
  **Workload Identity Federation** (Terraform creates the pool, restricted to this repo).
- Set `github_repo` in each `infra/envs/*.tfvars` — it is a placeholder (`naaradh/naaradh`) today.

## 4. Database (Neon)

The database is Neon Postgres 16 (ADR-0004), not Cloud SQL. Follow
**`docs/runbooks/neon-bootstrap.md`** once per environment:

1. Create the project in **Singapore** (`aws-ap-southeast-1`; no India region — Q-16). Production:
   history/PITR ≥ 7 days, autosuspend **off**.
2. Create the roles `naaradh_app` (NOBYPASSRLS) and `naaradh_service` (BYPASSRLS), the default
   privileges and extensions, exactly as the runbook says.
3. Allow-list the **Cloud NAT static IPs** from `terraform output` in Neon's IP allow-list.
4. Record the three connection strings as secrets: `DATABASE_URL` (pooled, app role),
   `DATABASE_SERVICE_URL` (pooled, service role), `DATABASE_MIGRATOR_URL` (**direct**, owner).
   Migrations then run as the `migrate` Cloud Run Job on every deploy.

## 5. Terraform bootstrap (P0-INF-4)

Order matters (details in `infra/README.md` and `deploy.md`):

1. Create the **state bucket** by hand, once per project: `naaradh-tfstate-<env>` in `asia-south1`,
   versioning on, uniform access. (It is not managed by the state it holds.)
2. Fill `infra/envs/<env>.tfvars`: `project_id`, `github_repo`, `hostnames`, `iap_members`,
   `alert_email`, sizing. **Never put a secret in a tfvars file** — they are committed.
3. `terraform -chdir=infra init -backend-config=…` → `plan -var-file=envs/<env>.tfvars` → review →
   `apply`. The first apply creates empty **secret containers**, networking, Redis, Pub/Sub, the
   bucket, KMS, the load balancer, Armor, monitoring and the Cloud Run services (with a bootstrap
   image).
4. **Add secret values** ([07](07-secrets-and-configuration.md)), then re-deploy.
5. Enable `web`, `shopify` and `console` in the tfvars (`services.<name>.enabled = true` and a
   hostname) once their secrets have values; apply.
6. **Console only:** after it exists, read the IAP backend service id and set
   `service_env.console.IAP_AUDIENCE = "/projects/<number>/global/backendServices/<id>"`; apply
   again. The console refuses to start in production without it.

Go dev → stage → prod-in. Decisions in the Terraform a human should look at before production
(from the infra review): ~13 vCPUs always on per environment, WAF rules in log-only mode on
hooks/voice, recordings deleted with no soft-delete window, Redis without TLS inside the VPC.

## 6. Deploys

After bootstrap, `.github/workflows/deploy.yml` builds all seven images on every merge to `main`,
runs the `migrate` job, and rolls stage; production is a manual run with reviewer approval.
Roll-back is a traffic switch to the previous revision (`deploy.md` §3). Services that are not
enabled in an environment are skipped.

## 7. Monitoring and alerts

Terraform creates `/healthz` uptime checks and log-based alerts (complaint auto-pause, global kill
switch, billing reconciliation delta, low margin, write-back give-up, erasure overdue, dead
letters, Redis memory). Set `alert_email` in the tfvars so they reach someone. On-call rota and a
status page are Phase 3 (P3-OPS-1).

## 8. Staff console access (IAP)

The console is reachable only through Identity-Aware Proxy. Put staff Google accounts (or a group
such as `staff@naaradh.com`) in `iap_members`; the app additionally checks the email against
`CONSOLE_ALLOWED_DOMAIN` / `CONSOLE_STAFF_EMAILS`. Enforce 2-step verification in Workspace.
`[VERIFY]` IAP with a Google-managed OAuth client was not tested before apply.

## 9. Checklist

- [ ] Organisation, billing account + budgets, four projects, org policies
- [ ] Domain on Cloud DNS, DNSSEC, CAA; registrar lock + 2FA
- [ ] GitHub org, branch protection, environments with reviewers, WIF variables
- [ ] Neon per environment; roles; NAT IPs allow-listed; three connection strings saved
- [ ] State buckets; tfvars filled (no secrets); `terraform apply` dev → stage → prod
- [ ] Secret values added; `web`/`shopify`/`console` enabled; console IAP audience set
- [ ] `alert_email` set; first deploy green; `/healthz` on every host
