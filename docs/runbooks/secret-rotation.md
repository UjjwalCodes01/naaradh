# Secret rotation

**Trigger:** the quarterly rotation (PLAN cross-phase track), a person with access leaving, a suspected leak, or a provider forcing a new credential. First rotation: P3-INF-2 (checklist at the end).

Secret **containers** are Terraform's; **values** are added by a human with `gcloud secrets versions add … --data-file=-` and picked up when a revision starts (`deploy.md` §5). The key-holder map in `infra/locals.tf` says which service may read which secret — rotating never changes it.

```bash
export PROJECT=naaradh-prod-in REGION=asia-south1
add() { gcloud secrets versions add "$1" --project "$PROJECT" --data-file=-; }   # value from stdin, never from the command line
roll() { for s in "$@"; do gcloud run services update "$s" --project "$PROJECT" --region "$REGION" --update-labels=secret-rotated=$(date +%s); done; }
```

## Classes

### A. Add a version, roll the holders

| Secret | Holders (locals.tf) | Notes |
|---|---|---|
| `ENGINE_WEBHOOK_KEY` | hooks, voice, every worker | **Only between calls**: it tags webhook and tool URLs of calls in flight. Flip the global kill switch, wait for live attempts to end (`select count(*) from call_attempts where ended_at is null`), rotate, roll, lift the switch. |
| `REDIS_URL` | api, voice, web, console, workers | Rotate the AUTH string in Terraform (`google_redis_instance` auth), build the URL from outputs (`deploy.md` §5), add, roll everything. |
| `POSTMARK_TOKEN` | web, workers-notifications | New server token in Postmark → add → roll → delete the old token in Postmark. |
| `RAZORPAY_KEY_ID` / `_SECRET` / `_WEBHOOK_SECRET` | api, web, workers-billing / hooks | Generate in the Razorpay dashboard (both keys change together); webhook secret is set on the webhook there. Roll, then deactivate the old key pair. |
| `BOLNA_API_KEY` etc. | hooks, voice, dispatcher, results, reconcile | New key in the engine dashboard → add → roll → revoke old. |
| `DATABASE_URL` / `DATABASE_SERVICE_URL` / `DATABASE_MIGRATOR_URL` | see map | Reset the role's password in Neon (`neon-bootstrap.md`), add the three URLs, roll all; the old password stops working on reset, so do it in a quiet window. |

Verify: `/readyz` green on every rolled service, no `Environment is invalid` or auth errors in the logs for 10 minutes.

### B. Rotate at the provider first

`SHOPIFY_API_SECRET`: in the app's settings (Dev Dashboard) rotate the client secret — Shopify keeps both valid for a window. Add the new value (holders: hooks, shopify, four workers), roll, then revoke the old one in Shopify. Per-shop custom-app secrets (`SHOPIFY_WEBHOOK_SECRETS`, Client A's mirror) are rotated in that store's admin, then the JSON map is re-added.

### C. Re-encryption jobs (a previous-key window)

The ciphertexts carry a `kid`, so rotation is a job that re-encrypts row by row, never a guess. Both the old and the new key exist for the duration; the jobs are idempotent and print counts only.

**`SHOPIFY_TOKEN_KEY`** (seals Shopify sessions; holders: shopify app + writebacks/actions/billing/reconcile workers)

1. `openssl rand -base64 32` → add it as `SHOPIFY_TOKEN_KEY`; add the retiring key as a new secret version of `SHOPIFY_TOKEN_KEY_PREVIOUS` (create the container the first time — it is not in Terraform yet; grant the same holders) and set env `SHOPIFY_TOKEN_KID=2`, `SHOPIFY_TOKEN_KID_PREVIOUS=1` (tfvars `service_env` for those services). Apply, roll. Every holder now opens either kid and seals with the new one.
2. Run the job (workers image, service role):
   ```bash
   gcloud run jobs execute rotate-shopify-token-key --project $PROJECT --region $REGION   # if the job exists, or:
   DATABASE_SERVICE_URL=… SHOPIFY_TOKEN_KEY=… SHOPIFY_TOKEN_KID=2 SHOPIFY_TOKEN_KEY_PREVIOUS=… SHOPIFY_TOKEN_KID_PREVIOUS=1 \
     node dist/rotate-shopify-token-key.js
   ```
   It prints `{ rotated, skipped, failed, remaining }`; rerun until `remaining` is 0 (`skipped` rows were being refreshed at that moment). `failed > 0` means a row cannot be opened with either key — that store must reinstall (`shopify-writeback.md` "reconnecting a store").
3. Remove the `*_PREVIOUS` pair from env, roll, destroy the old secret version.

**`PHONE_ENC_*`** (customer numbers; private half only in dispatcher/results/reconcile) and **`STAFF_ENC_*`** (staff numbers; private half only in voice)

No service may hold two private keys, so the job runs from a **trusted laptop** that pulls both keys from Secret Manager into the environment of one process and nowhere else:

1. Generate the new pair (`docs/go-live/07-secrets-and-configuration.md` §1). Add the new **public** key as `PHONE_ENC_PUBLIC_KEY` and the new private key as `PHONE_ENC_PRIVATE_KEY`; set `PHONE_ENC_KID=2`. Do **not** roll yet.
2. Run, with the OLD private key and the NEW public key:
   ```bash
   DATABASE_SERVICE_URL=… ROTATE_FROM_KID=1 ROTATE_FROM_PRIVATE_KEY="$(gcloud secrets versions access <old> --secret PHONE_ENC_PRIVATE_KEY --project $PROJECT)" \
   ROTATE_TO_KID=2 ROTATE_TO_PUBLIC_KEY="$(gcloud secrets versions access latest --secret PHONE_ENC_PUBLIC_KEY --project $PROJECT)" \
     node dist/rotate-phone-enc-key.js          # contacts.phone_enc
   # staff pair: the same with STAFF_ENC_* values and dist/rotate-staff-enc-key.js (transfer_targets, inbound_profiles fallback)
   ```
   Until `remaining` is 0, dispatch would fail on rows still on kid 1 once the dispatcher holds only the new private key — so keep the old private key version **enabled** and roll the holders only when the job reports 0 remaining. `failed` rows cannot be decrypted with the old key: they are left on the old kid for a human to look at; the number cannot be dialled until the contact is refreshed (a new order re-encrypts it).
3. Roll dispatcher/results/reconcile (customer) or voice (staff); disable, then destroy, the old private key version. Shred the laptop's shell history and any temp files.

Each job writes one `audit_log` row per table (`key.rotated`, counts only).

### D. Never rotate casually

**`PHONE_HASH_KEY`** keys every `phone_hash` column (contacts, attempts, intents, suppressions, consents, complaints, orders, erasure requests). A new key orphans every suppression and consent: opted-out people would be called. If it ever must change (proven leak): add `phone_hash_v2` columns, backfill by decrypting each contact's number and re-hashing (a job like class C, from the dispatcher's key), switch lookups to v2 behind a flag, then drop v1 — a migration project with its own ADR, not a rotation.

## Rollback

Class A/B: re-enable the previous secret version (`gcloud secrets versions enable`), roll. Class C: the previous-key window means nothing is unreadable during the job; if the job misbehaves, stop it — rows are either fully on the old kid or fully on the new one, and every holder can open both until step 3.

## First rotation (P3-INF-2)

| Date | Secret | Class | Who | Result |
|---|---|---|---|---|
| | `ENGINE_WEBHOOK_KEY` | A | | not yet run |
| | `SHOPIFY_TOKEN_KEY` | C | | not yet run (staging first) |
| | `PHONE_ENC_*` | C | | not yet run (staging first) |
| | `STAFF_ENC_*` | C | | not yet run (staging first) |
| | Neon role passwords | A | | not yet run |
