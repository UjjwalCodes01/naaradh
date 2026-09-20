# Deploy, roll back, apply infrastructure

**Symptom / trigger:** you are shipping code, a deploy went wrong, infrastructure needs to change, or a secret needs a new value.

**Who does what:**

| Change | How | Who |
|---|---|---|
| New code (images) | `.github/workflows/deploy.yml` — main → stage automatically; production by `workflow_dispatch` through the protected `production` environment | CI, a human approves prod |
| Database schema | the `migrate` Cloud Run Job, run by the same workflow **before** services roll | CI |
| Infrastructure, IAM, secrets containers, sizing, env vars | `terraform apply` from a laptop after reviewing the plan | **a human only** (AGENTS.md §1) |
| Secret values | `gcloud secrets versions add` | a human only |

CI owns the **image** of every Cloud Run service and job; Terraform owns everything else and ignores image drift, so an apply never rolls a deploy back and a deploy never changes config.

Set these once per shell (values from `terraform -chdir=infra output`):

```bash
export PROJECT=naaradh-stage-in REGION=asia-south1
export REPO=$REGION-docker.pkg.dev/$PROJECT/naaradh
```

---

## 1. Normal deploy

**Stage:** merge to `main`. The workflow builds `api hooks voice workers` tagged with the commit SHA (skipped if that tag already exists — tags are immutable), updates and runs the `migrate` job, then rolls services in this order: all `workers-*`, `hooks`, `api`, `voice`. Each `gcloud run services update` waits for the new revision's startup probe (`/readyz`: Postgres + Redis answer) before moving traffic.

**Production:** Actions → deploy → Run workflow → `environment: production`, `ref: <full SHA that is already on stage>`. Reviewers of the `production` environment approve. Production builds its own images from that SHA into the production registry (lockfile and base image are pinned, so the build is the same code; digests may differ — see "Open items" at the end).

**Migrations are forward-only and must be backward compatible with the code that is still running** (expand → deploy → contract in a later PR): the job runs before services roll, so for a few minutes old code runs on the new schema.

## 2. After every deploy — check

```bash
# every service is on the new revision and Ready
gcloud run services list --project $PROJECT --region $REGION \
  --format='table(metadata.name, status.latestReadyRevisionName, status.conditions[0].status)'

# the migration job succeeded
gcloud run jobs executions list --job migrate --project $PROJECT --region $REGION --limit 3

# health through the load balancer
for h in api hooks voice; do curl -fsS https://$h.stage.naaradh.com/healthz; echo " $h"; done

# errors since the deploy (workers log `severity`; api/hooks/voice log pino `level` 50+)
gcloud logging read --project $PROJECT --freshness 15m \
  'resource.type="cloud_run_revision" AND (severity>=ERROR OR jsonPayload.level>=50)' --limit 50
```

Also look at: Monitoring → Alerting (no new incidents), the dispatcher still claiming (`workers-dispatcher` logs), Pub/Sub subscription backlog not growing.

## 3. Roll back a service (seconds, no rebuild)

Traffic goes back to the previous revision; nothing is rebuilt and the schema is untouched.

```bash
gcloud run revisions list --service api --project $PROJECT --region $REGION --limit 5
gcloud run services update-traffic api --project $PROJECT --region $REGION \
  --to-revisions <previous-revision-name>=100
```

Do the same for each affected service (workers are one service per role: `workers-dispatcher`, …). `voice` carries live calls: rolling back moves new requests only; calls in progress finish on their instance.

To get back to "latest revision serves" after fixing forward:

```bash
gcloud run services update-traffic api --project $PROJECT --region $REGION --to-latest
```

**A migration cannot be rolled back by redeploying.** If a migration broke something, fix forward with a new migration (a human writes it, CI runs it). Neon branch-from-timestamp is the last resort (`restore-drill.md`, ADR-0004).

## 4. Apply Terraform (plan → review → apply)

Prerequisites: `gcloud auth application-default login` as an account with owner/editor on the project; Terraform 1.16.x.

```bash
ENV=stage   # dev | stage | prod-in
terraform -chdir=infra init -reconfigure \
  -backend-config="bucket=naaradh-tfstate-$ENV" -backend-config="prefix=naaradh/$ENV"

terraform -chdir=infra plan -var-file=envs/$ENV.tfvars -out=/tmp/$ENV.tfplan
```

Review before applying — stop and ask if you see any of:

- a `destroy` or `must be replaced` on `google_redis_instance`, `google_storage_bucket`, `google_kms_*`, `google_compute_address` (NAT IPs are in Neon's allow-list), `google_bigquery_*`, or a Cloud Run service you did not mean to disable;
- a change to any `google_secret_manager_secret_iam_member` — that is the key-holder map (`infra/locals.tf`); it needs a security review;
- an IAM grant at project level that is not in `modules/iam` or `modules/secrets` (merchant-webhook prefix).

```bash
terraform -chdir=infra apply /tmp/$ENV.tfplan
```

The PR that changed `infra/` already has a read-only plan in its checks (`terraform plan` workflow) — compare it with yours.

**Enabling a new service** (e.g. `web`, `shopify`, `console` — their images are built by `deploy.yml` like the others): its image must already be in the registry (or leave `image_tag = "bootstrap"`), all its non-optional secrets must have versions (§5), then set `services.web.enabled = true` and `hostnames.web` in the env's tfvars and apply. The LB, certificate, Armor policy and uptime check follow automatically. **Console:** after the first apply creates the IAP backend service, read its id (`gcloud compute backend-services list`) and set `service_env.console.IAP_AUDIENCE = "/projects/<number>/global/backendServices/<id>"`, then apply again — the console refuses to start in production without it.

## 5. Add or rotate a secret value

Secret containers come from Terraform; **values never do**. Add a version (the value is read from a file or stdin so it never lands in shell history):

```bash
gcloud secrets versions add PHONE_HASH_KEY --project $PROJECT --data-file=- < /path/to/value
```

Services read `latest` **when a revision starts**, so roll the holders to pick it up (no rebuild):

```bash
# which services hold it: see the key-holder map in infra/locals.tf, or:
terraform -chdir=infra output services
gcloud run services update api --project $PROJECT --region $REGION --update-labels=secret-rotated=$(date +%s)
```

Keys with special rules — read before touching (full procedures: `secret-rotation.md`):

- `PHONE_HASH_KEY` — rotating it orphans every suppression and consent row (hashes change). It is a re-hash migration, not a rotation. Never "just add a version".
- `PHONE_ENC_*` / `STAFF_ENC_*` — add the new key pair with a new `*_KID`; old ciphertexts stay readable only while the old private key is still available to the dispatcher/results/reconcile (customer) or voice (staff).
- `SHOPIFY_TOKEN_KEY` — rotation is a re-encryption job (ADR-0007), not a config flip.
- `REDIS_URL` — built from Terraform outputs: `redis://:$(terraform -chdir=infra output -raw redis_auth_string)@$(terraform -chdir=infra output -raw redis_host):6379`. Pipe it straight into `gcloud secrets versions add REDIS_URL --data-file=-`; do not echo it.
- `DATABASE_*` — from the Neon console (`neon-bootstrap.md`). `DATABASE_MIGRATOR_URL` is the **direct** endpoint; the job refuses a `-pooler.` URL.

**Optional secrets** (engine API keys, `BOLNA_TOOL_TOKEN`, Razorpay, Stripe, `SHOPIFY_WEBHOOK_SECRETS`, `REGION_SYNC_PRIVATE_KEY`): Cloud Run will not start a revision whose secret has no version, so they are mounted only when listed in `enabled_optional_secrets` in the env's tfvars. Add the version first, then list it and apply.

Disable an old version once nothing uses it: `gcloud secrets versions disable <n> --secret NAME --project $PROJECT`.

## 6. Run migrations by hand

Normally CI does this. By hand (e.g. after a failed CI run you have fixed):

```bash
gcloud run jobs update migrate --project $PROJECT --region $REGION \
  --image $REPO/workers:<sha> --command node --args dist/migrate.js
gcloud run jobs execute migrate --project $PROJECT --region $REGION --wait
gcloud logging read --project $PROJECT --freshness 30m \
  'resource.type="cloud_run_job" AND resource.labels.job_name="migrate"' --limit 50
```

Success prints `migrations applied`. The job has `max_retries = 0` on purpose: a failed migration is looked at, not retried. It is the only principal with `DATABASE_MIGRATOR_URL`.

## 7. Dead letters (alert "Pub/Sub dead letters waiting")

An event failed 10 deliveries. Messages carry only a `webhook_events` id, never PII.

```bash
gcloud pubsub subscriptions pull naaradh.engine.events.results.dlq.hold --project $PROJECT --limit 10 --format=json
```

Find the cause in the consumer's logs (`handler failed; nack`, with `message_id`), fix it, then re-publish the same payload to the source topic (`naaradh.engine.events`) and ack it on the hold subscription. Handlers are idempotent, so a duplicate is harmless. Subscriptions use ordering keys (tenant id): one poison message holds back that tenant's later events until it dead-letters.

## 8. Refresh the Node base image

All four `apps/*/Dockerfile` pin `node:22.<x>.<y>-bookworm-slim@sha256:…`. Monthly, or when trivy reports a fixable CRITICAL in the base:

```bash
docker pull node:22-bookworm-slim
docker run --rm node:22-bookworm-slim node -v                      # → v22.x.y
docker pull node:22.x.y-bookworm-slim
docker inspect --format '{{index .RepoDigests 0}}' node:22.x.y-bookworm-slim
```

Update `ARG NODE_IMAGE=` in all four Dockerfiles in one PR; the `images` CI job builds and scans them.

## 9. Bootstrap a new environment (once)

See `infra/README.md` → "Bootstrap". Summary: state bucket by hand → targeted apply (APIs, IAM, network, KMS, registry, secrets, Redis) → add secret values and Neon allow-list → full apply with `image_tag = "bootstrap"` → GitHub environment variables → first CI deploy → DNS.

---

**Open items this runbook depends on:** production images are rebuilt from the SHA instead of promoting stage digests (a shared registry in `naaradh-shared` would allow digest promotion); the GCS soft-delete window for recordings is 0 (a deleted recording is unrecoverable — confirm with legal, `infra/variables.tf recordings_soft_delete_seconds`).
