# 7. Secrets and configuration

Every service validates its environment at start-up and **refuses to boot** with a clear list of
what is missing or not allowed (names only, never values). Secret **containers** are created by
Terraform; secret **values** are added by a human with `gcloud secrets versions add` (deploy.md
§5). Who may read each secret is the **key-holder map** in `infra/locals.tf` — a security
invariant enforced at plan time (e.g. the customer private key can never reach the dashboard).

Locally, one `.env.local` (git-ignored) holds everything; start from `.env.example` and
`pnpm keys:dev`. Services that must never hold a key refuse it only in production, so a shared
local file works.

## 1. Keys you generate yourself

Generate on a trusted machine, pipe straight into Secret Manager, keep an offline backup of the
private keys (losing `PHONE_ENC_PRIVATE_KEY` means no stored number can ever be dialled again).
Use **different values per environment**.

```bash
openssl rand -base64 32                          # PHONE_HASH_KEY, SHOPIFY_TOKEN_KEY
openssl rand -hex 32                             # ENGINE_WEBHOOK_KEY
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out phone_enc_private.pem
openssl pkey -in phone_enc_private.pem -pubout -out phone_enc_public.pem   # PHONE_ENC_* pair
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out staff_enc_private.pem
openssl pkey -in staff_enc_private.pem -pubout -out staff_enc_public.pem   # STAFF_ENC_* pair

gcloud secrets versions add PHONE_ENC_PRIVATE_KEY --project $PROJECT --data-file=phone_enc_private.pem
shred -u phone_enc_private.pem   # after the offline backup is made
```

| Secret | What it protects | Rules |
|---|---|---|
| `PHONE_HASH_KEY` | Keyed hash of every phone number (lookups, suppressions, consents) | **Never rotate casually** — a new key orphans every suppression and consent (re-hash migration) |
| `PHONE_ENC_PUBLIC_KEY` / `PHONE_ENC_PRIVATE_KEY` | Customer numbers encrypted at rest; decrypted only to dial | Private half: workers dispatcher, results, reconcile **only** |
| `STAFF_ENC_PUBLIC_KEY` / `STAFF_ENC_PRIVATE_KEY` | Merchant staff numbers (transfer, fallback) | Private half: voice **only**; voice never holds the customer key |
| `ENGINE_WEBHOOK_KEY` | Tags engine webhook and tool URLs per tenant | Changing it invalidates URLs of calls in flight — rotate between calls |
| `SHOPIFY_TOKEN_KEY` | Seals Shopify access/refresh tokens in Postgres | Rotation: set the retiring key as `SHOPIFY_TOKEN_KEY_PREVIOUS` / `SHOPIFY_TOKEN_KID_PREVIOUS`, run `rotate-shopify-token-key`, drop the previous pair (`docs/runbooks/secret-rotation.md`); losing it = every store reopens the app |

## 2. Values you get from providers

| Secret | From | Page |
|---|---|---|
| `DATABASE_URL`, `DATABASE_SERVICE_URL`, `DATABASE_MIGRATOR_URL` | Neon (pooled app, pooled service, **direct** owner) | [05](05-cloud-infrastructure.md#4-database-neon) |
| `REDIS_URL` | Terraform outputs (Memorystore host + AUTH) | deploy.md §5 |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | Shopify app Client ID / secret (per environment's app) | [04](04-shopify-app.md#credentials--configuration) |
| `SHOPIFY_WEBHOOK_SECRETS` *(optional)* | Per-shop secrets for custom apps (Client A until migrated) | [04](04-shopify-app.md#9-moving-client-a-from-the-custom-app-to-the-public-app) |
| `POSTMARK_TOKEN` | Postmark server API token | [06](06-email-and-payments.md#2-postmark-transactional-email) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` *(optional)* | Razorpay dashboard | [06](06-email-and-payments.md#3-razorpay) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` *(optional, US/EU)* | Stripe dashboard (restricted key; webhook endpoint signing secret) | [10](10-us-eu.md#6-stripe-p6-bill-1) |
| `REGION_SYNC_PRIVATE_KEY` *(optional, multi-region only)* | `generateRegionKeyPair()` — one per region | [runbook](../runbooks/region-directory.md#keys) |
| `BOLNA_API_KEY`, `OMNIDIM_API_KEY`, `RETELL_API_KEY` *(optional)* | Engine dashboards | [03](03-voice-engine.md) |
| `SIMULATOR_WEBHOOK_SECRET` *(optional, stage/dev only)* | `openssl rand -hex 32` | Signs the simulator's webhooks and tool calls; listed in `enabled_optional_secrets` |

**Optional** secrets are mounted only when listed in the environment's `enabled_optional_secrets`
(Cloud Run cannot start a revision whose secret has no version). **All other secrets must have a
value before their services can start** — including the Shopify credentials for the four workers
that call Shopify, so create the staging Shopify app before the first stage deploy.

Reserved names with no code behind them: `WEBHOOK_SIGNING_KEY` (merchant webhooks use one
secret per endpoint instead — do not list it in `enabled_optional_secrets`), `KILL_SWITCH_GLOBAL`
(use the kill switch in the console or Redis instead).

Engine keys (`*_API_KEY`, `SIMULATOR_WEBHOOK_SECRET`) are held only by hooks, voice and the
dispatcher/results/reconcile workers; only those roles check engine configuration at boot, so
the other worker roles start without them.

## 3. Who holds what (production)

From the key-holder map; ✓ = mounted. Workers are one service per role (`workers-<role>`).

| Secret | api | hooks | voice | web | shopify | console | workers |
|---|---|---|---|---|---|---|---|
| `DATABASE_URL` (app role, RLS) | ✓ | | ✓ | ✓ | ✓ | ✓ | all |
| `DATABASE_SERVICE_URL` (bypasses RLS) | | ✓ | | | | ✓ | all |
| `DATABASE_MIGRATOR_URL` | only the `migrate` job | | | | | | |
| `REDIS_URL` | ✓ | | ✓ | ✓ | | ✓ | all |
| `PHONE_HASH_KEY` | ✓ | | ✓ | ✓ | ✓ | ✓ | all |
| `PHONE_ENC_PUBLIC_KEY` | ✓ | | ✓ | | | | all |
| `PHONE_ENC_PRIVATE_KEY` | | | | | | | dispatcher, results, reconcile |
| `STAFF_ENC_PUBLIC_KEY` | ✓ | | | ✓ | ✓ | | |
| `STAFF_ENC_PRIVATE_KEY` | | | ✓ | | | | |
| `ENGINE_WEBHOOK_KEY` | | ✓ | ✓ | | | | all |
| Engine API keys | | ✓ | ✓ | | | | dispatcher, results, reconcile |
| `SHOPIFY_API_KEY` / `SHOPIFY_TOKEN_KEY` | | | | | ✓ | | writebacks, actions, billing, reconcile |
| `SHOPIFY_API_SECRET` | | ✓ | | | ✓ | | writebacks, actions, billing, reconcile |
| `RAZORPAY_KEY_ID` / `_SECRET` | ✓ | | | ✓ | | | billing |
| `RAZORPAY_WEBHOOK_SECRET` | | ✓ | | | | | |
| `POSTMARK_TOKEN` | | | | ✓ | | | notifications |

## 4. Plain settings (not secret)

Set in the tfvars (`common_env` for all services, `service_env` per service). Terraform already
sets `NODE_ENV`, region, `PUBSUB_TOPIC_PREFIX`, `RECORDINGS_BUCKET`, `WORKER`, the `HOOKS_BASE_URL` /
`VOICE_BASE_URL` for voice and workers, and the public URLs below from `hostnames`.

| Variable | Service | Value / default | Note |
|---|---|---|---|
| `ENGINE_DEFAULT_IN`, `ENGINE_DEFAULT_US`, `ENGINE_SECONDARY_IN` | voice, hooks, workers | `simulator` | Set to the ADR-0001 engine once its adapter exists. **Production refuses the simulator** unless `SIMULATOR_ALLOWED=true` (stage only), and refuses the repo's development `SIMULATOR_WEBHOOK_SECRET` — stage holds a real one as an optional secret |
| `TRUST_PROXY_HOPS` | api, hooks, voice, console | `2` behind the load balancer (Terraform sets it) | How many trailing `X-Forwarded-For` entries are ours; the client IP for rate limits and API-key allow-lists is derived from it. Verify on stage |
| `SHOPIFY_WRITEBACK` | workers | `live` in production, `recording` elsewhere | Stage stays `recording` except for the write-back test |
| `SHOPIFY_ADMIN_API_VERSION` | workers, shopify | `2026-07` | Equal to `api_version` in shopify.app.toml |
| `SHOPIFY_BILLING_TEST` | shopify | `true` outside production | Test charges |
| `APP_URL` | web | `https://app.naaradh.com` | Links in sign-in emails |
| `DASHBOARD_URL` | shopify, workers-notifications | `https://app.naaradh.com` | Links in the app and emails |
| `SHOPIFY_APP_URL` | shopify | `https://shopify.naaradh.com` | Must match the toml |
| `CONSOLE_ORIGIN`, `CONSOLE_ALLOWED_DOMAIN`, `CONSOLE_STAFF_EMAILS` | console | origin, `naaradh.com`, list | Staff allow-list on top of IAP |
| `IAP_AUDIENCE` | console | `/projects/<n>/global/backendServices/<id>` | Second apply ([05](05-cloud-infrastructure.md#5-terraform-bootstrap-p0-inf-4)) |
| `MAIL_FROM` | web, workers | `Naaradh <no-reply@mail.naaradh.com>` | Must be on the verified Postmark domain |
| `RAZORPAY_PLAN_IDS` | api, web | JSON map | [06](06-email-and-payments.md#3-razorpay) |
| `MEDIA_STORE` | web | `gcs` in production | `dev` fakes signed URLs locally |
| `BIGQUERY_DATASET`, `BIGQUERY_TABLE`, `BIGQUERY_LOCATION` | workers-analytics | set by Terraform from the dataset | Nightly facts export (P2-INF-2); unset locally → in-memory sink |
| `ENGINE_DAILY_CAP_PAISE`, `GLOBAL_DAILY_CAP_PAISE`, `ENGINE_MAX_CONCURRENCY` | workers, voice | ₹50,000 / ₹2,00,000 per day; 20 channels | Platform-wide safety caps |
| `RATE_LIMIT_*`, `DEFAULT_KEY_DAILY_CAP` | api, hooks, voice | see `.env.example` | |
| `LOG_LEVEL` | all | `info` | |

## 5. Checklist

- [ ] Keys generated per environment; private keys backed up offline; nothing in chat, email or git
- [ ] Every non-optional secret has a version before its services are enabled
- [ ] Optional secrets listed in `enabled_optional_secrets` only after a version exists
- [ ] Stage runs the simulator (`SIMULATOR_ALLOWED=true`). **prod-in cannot boot on the simulator** — hooks, voice and the engine workers refuse it — so prod-in is deployed only after the ADR-0001 adapter is merged and `ENGINE_DEFAULT_IN` names it (an engine with no adapter is refused at boot too)
- [ ] Paging channel keys passed as `TF_VAR_pagerduty_service_key` / `TF_VAR_alert_webhook_url` at apply time, never written to tfvars
- [ ] First secret rotation done on staging (`docs/runbooks/secret-rotation.md`, P3-INF-2 table)
