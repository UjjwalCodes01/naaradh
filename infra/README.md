# infra

Terraform for one GCP project per environment (`asia-south1`). **Agents write plans; a human applies** (AGENTS.md §1). No click-ops: anything created in the console is invisible to the next person.

Day-to-day operations — deploy, roll back, apply, rotate a secret — are in [`docs/runbooks/deploy.md`](../docs/runbooks/deploy.md).

| Env | Project | tfvars | GitHub environment |
|---|---|---|---|
| dev | `naaradh-dev` | `envs/dev.tfvars` | `dev` |
| stage | `naaradh-stage-in` | `envs/stage.tfvars` | `stage` (main deploys here) |
| prod | `naaradh-prod-in` | `envs/prod-in.tfvars` | `production` (manual, reviewers) |

Later: `naaradh-prod-us` / `naaradh-prod-eu` from the same modules (P6-INF-1). `naaradh-shared` holds Cloud DNS. Org policy restricts locations to `asia-south1` / `asia-south2`; recordings buckets require CMEK. `envs/*.tfvars` are committed and **must never contain a secret**.

## What exists

| Path | What |
|---|---|
| `versions.tf` | Terraform ≥ 1.9 < 2; `google` / `google-beta` pinned to 7.46.1; `.terraform.lock.hcl` committed |
| `backend.tf` | `gcs` backend, bucket/prefix given at `init` (partial config) |
| `locals.tf` | service catalog, **key-holder map** + plan-time guards, plain env |
| `main.tf` | wiring; `variables.tf`, `outputs.tf` |
| `modules/network` | VPC, Direct-VPC-egress subnet, Cloud Router + **Cloud NAT with static IPs** (Neon allow-list, ADR-0004), private services access |
| `modules/kms` | key ring `naaradh-<env>`, keys `recordings` and `analytics` (90-day rotation), service-agent grants |
| `modules/gcs` | recordings bucket: CMEK, UBLA, public access prevention, no versioning, 400-day safety-net delete (the retention worker deletes per tenant) |
| `modules/secrets` | empty secret containers (regional replication), per-secret accessor grants, runtime `merchant-webhook-*` prefix grants |
| `modules/redis` | Memorystore Redis 7, PSA, AUTH on, `noeviction`, maintenance 03:00 IST |
| `modules/pubsub` | topics `naaradh.{shopify,engine,provider,billing}.events`, subscriptions `naaradh.<topic>.<worker>` with dead-letter topics (10 attempts) and `*.dlq.hold` subscriptions |
| `modules/cloudrun-service` | one Cloud Run v2 service: own SA, Direct VPC egress (all traffic), secrets by reference, `/readyz` startup + `/healthz` liveness probes; image ignored after creation |
| `modules/cloudrun-job` | the `migrate` job (workers image, `node dist/migrate.js`) |
| `modules/lb` | global external HTTPS LB, serverless NEGs, Certificate Manager (DNS-authorized certs), HTTP→HTTPS, IAP on `console` |
| `modules/armor` | Cloud Armor policies `api`, `hooks`, `voice`, `standard`, `console` |
| `modules/iam` | runtime SAs `run-<service>`, GitHub **Workload Identity Federation**, `deployer` and read-only `tf-planner` |
| `modules/artifact-registry` | Docker repo `naaradh` (immutable tags, cleanup policies in dry-run) |
| `modules/bigquery` | dataset `naaradh_analytics` (CMEK), table `daily_call_facts` (no PII), SA `analytics-export` |
| `modules/monitoring` | `/healthz` uptime checks, log-match alerts for events that need a human, error-rate metrics, dead-letter and Redis-memory alerts |
| `docker/` | build helpers for `apps/*/Dockerfile` (import check, migrate-job entrypoint + tsup config) |

**Not here:** Postgres. The database is Neon (ADR-0004); its connection strings are secrets. `DATABASE_MIGRATOR_URL` is the direct endpoint and only the `migrate` job holds it.

### Services

| Key | Ingress | Min / max | CPU | Notes |
|---|---|---|---|---|
| `api` | LB | 1 / 10 | request | `api.<domain>` |
| `hooks` | LB | 1 / 10 | request | `hooks.<domain>`, ack p99 < 800 ms |
| `voice` | LB | **2** / 10 | **always** | a cold start mid-call is dead air; guard fails the plan below 2 |
| `web` / `shopify` | LB | 0 / 5 | request | `enabled = false` until their images exist |
| `console` | LB + **IAP** | 0 / 2 | request | staff only; invoker is the IAP service agent |
| `workers-<role>` × 11 | internal only | 1 / 1–2 | **always** | `WORKER=<role>`: intents, dispatcher, results, reconcile, deliveries, actions, writebacks, complaints, retention, billing, notifications |
| `migrate` (job) | — | — | — | runs before every rollout |

Sizing and on/off are overridable per env (`services = { … }`); ingress, identity and secrets are not.

## Key-holder map (security invariant)

Defined once in `locals.tf` (`secret_holders`); it drives both the IAM grant (`roles/secretmanager.secretAccessor` on **the secret**, to **the service's own SA** — never project-wide) and which secrets are mounted. `terraform_data.key_holder_guard` fails the plan if the rules below are broken.

| Secret | Holders | Rule |
|---|---|---|
| `PHONE_ENC_PRIVATE_KEY` | workers dispatcher, results, reconcile | only code that may turn `phone_enc` back into a number (AGENTS.md §4) |
| `STAFF_ENC_PRIVATE_KEY` | voice | transfer targets; voice never holds the customer key (invariant 19) |
| `DATABASE_SERVICE_URL` (BYPASSRLS) | hooks, all workers, console | **never** api, voice, web, shopify (invariant 15) |
| `DATABASE_MIGRATOR_URL` | migrate job | owner role, direct endpoint (ADR-0004) |
| `DATABASE_URL` | api, voice, web, shopify, console, workers | RLS-bound app role |
| `SHOPIFY_TOKEN_KEY`, `SHOPIFY_API_KEY` | shopify, workers writebacks, actions, billing, reconcile | ADR-0007 |
| `SHOPIFY_API_SECRET` | hooks, shopify, the four Admin-API workers | HMAC verify / token refresh |
| `PHONE_HASH_KEY` | api, voice, web, console, workers | |
| `PHONE_ENC_PUBLIC_KEY` | api, voice, workers | encrypt only |
| `STAFF_ENC_PUBLIC_KEY` | api, web, console | |
| `ENGINE_WEBHOOK_KEY` | hooks, voice, workers | |
| engine API keys (`BOLNA_`, `OMNIDIM_`, `RETELL_API_KEY`) | hooks, voice, workers dispatcher, results, reconcile | optional |
| `RAZORPAY_KEY_ID/SECRET` | api, workers billing | optional |
| `RAZORPAY_WEBHOOK_SECRET`, `SHOPIFY_WEBHOOK_SECRETS` | hooks | optional |
| `POSTMARK_TOKEN` | web, console, workers notifications | |
| `WEBHOOK_SIGNING_KEY` | workers deliveries | optional |
| `REDIS_URL` | api, voice, web, console, workers | |
| `merchant-webhook-*` (created at runtime) | api creates + adds versions; workers deliveries reads | project-level bindings with a name-prefix IAM condition (`modules/secrets`) |

Other grants: `hooks` publishes to the topics; `workers-intents/results/billing` subscribe to their own subscription only; `api`, `web`, `console` read the recordings bucket and may sign **as themselves** (V4 signed URLs); `workers-results` writes and `workers-retention` deletes recordings. No runtime SA has a project-level role except the conditioned merchant-webhook bindings.

## Bootstrap (once per environment, by a human)

1. **Project** exists with billing (P0-INF-1). You have owner on it.
2. **State bucket** — never managed from the state it holds:

   ```bash
   ENV=stage PROJECT=naaradh-stage-in
   gcloud storage buckets create gs://naaradh-tfstate-$ENV --project $PROJECT \
     --location asia-south1 --uniform-bucket-level-access --public-access-prevention
   gcloud storage buckets update gs://naaradh-tfstate-$ENV --versioning
   ```

3. **Foundation apply** (APIs, identities, network, keys, registry, secret containers, Redis):

   ```bash
   terraform -chdir=infra init -backend-config="bucket=naaradh-tfstate-$ENV" -backend-config="prefix=naaradh/$ENV"
   terraform -chdir=infra plan -var-file=envs/$ENV.tfvars -out=/tmp/foundation.tfplan \
     -target=google_project_service.apis -target=module.iam -target=module.network \
     -target=module.kms -target=module.artifact_registry -target=module.secrets -target=module.redis
   terraform -chdir=infra apply /tmp/foundation.tfplan
   ```

4. **Secret values** — add a version to every non-optional secret whose holders are enabled (`docs/runbooks/deploy.md` §5; `pnpm keys:dev` shows the key formats — generate production keys fresh, never reuse dev ones). Neon: create roles (`docs/runbooks/neon-bootstrap.md`) and add `terraform output nat_egress_ips` to the Neon IP allow-list.
5. **Full apply** with `image_tag = "bootstrap"` (default): services start on a placeholder image; the `migrate` job exists but is not run.
6. **DNS** — if `dns.managed_zone` is empty, create the records from `terraform output dns_records` (A records to the LB IP and the certificate DNS-authorization CNAMEs) in the `naaradh-shared` zone. Certificates become ACTIVE within ~30 min of the CNAMEs resolving.
7. **GitHub** — environment `stage` / `production` (production: required reviewers, main only); per-environment variables from `terraform output github_actions`; repository variables `DEPLOY_ENABLED=true` and `TF_PLAN_WIF_PROVIDER_<ENV>`, `TF_PLAN_SA_<ENV>`, `TF_STATE_BUCKET_<ENV>` for the PR plan job.
8. **First deploy** — merge to main (stage) or dispatch (production). CI pushes images, runs `migrate`, rolls every service.

## Rules

- **CI owns images, Terraform owns config.** Cloud Run `image` is in `ignore_changes`; never set `image_tag` to "fix" a deploy — roll back with `gcloud run services update-traffic`.
- **No secret values in Terraform.** Containers only. The Redis AUTH string is the one secret Terraform necessarily knows (in state); the state bucket is locked down accordingly.
- **Adding a secret:** add it to `secret_holders` (and to `optional_secrets` if the code treats it as optional), apply, add a version, then deploy.
- **Adding a service:** add it to `service_catalog` in `locals.tf`, give it only the secrets it needs, keep `enabled = false` until its image exists.
- **Pub/Sub:** Terraform creates every topic and subscription. The code's create-if-missing path runs only against the emulator (`PUBSUB_EMULATOR_HOST`); runtime SAs have publisher/subscriber on specific resources and cannot create anything.

## Validate locally

```bash
terraform fmt -recursive -check infra
terraform -chdir=infra init -backend=false && terraform -chdir=infra validate
pnpm tf:plan ENV=stage     # read-only plan with your credentials (-lock=false)
```

## Cost notes (review before first apply)

- **Always-on CPU:** 11 worker services × 1 vCPU (min 1) + voice × 2 run 24/7 in every environment — roughly 13 vCPUs of instance-based billing per env before api/hooks. Options if that is too much for dev/stage: fewer worker services (consolidate low-volume roles), or fractional CPU after verifying Cloud Run's limits for always-allocated CPU.
- Cloud Armor Standard is billed per policy and per rule; only policies used by enabled LB services are created.
- Memorystore STANDARD_HA (prod) doubles the instance cost; BASIC elsewhere.
- NAT: one static IP per environment (two in prod).
