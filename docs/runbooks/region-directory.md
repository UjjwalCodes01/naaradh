# Region directory — Shopify webhooks for another region (ADR-0012 §4)

**Symptom:** a US or EU store's orders are not arriving, hooks logs show `shopify webhook forwarded to its region` with a non-2xx status or `shopify webhook forward failed`, or a store shows as `unknown_shop` in the region that should serve it.

## What the system does on its own

- Every 5 minutes the **reconcile** worker in each deployment lists the Shopify stores (installed, tenant in region) and phone numbers (not retired) it serves, writes them to its own `region_directory` rows, and pushes the same snapshot to each peer's `https://hooks.<region>.naaradh.com/internal/region-directory`, signed with that region's own Ed25519 key (`REGION_SYNC_PRIVATE_KEY`).
- A peer checks the signature with the sender's **public** key (`REGION_PEER_KEYS`) before reading the body, applies it only for the sender's own region, never over another region's rows, refuses snapshots older than 10 minutes, and releases what the sender stopped listing.
- Shopify sends every store's webhooks to `hooks.naaradh.com` (India). After the HMAC check, a webhook for a store the directory places in another region is passed through unchanged — Shopify's headers, raw body — to that region's hooks, which verifies it again. Nothing about it is stored in India. The peer's answer is returned to Shopify; if the peer is down, Shopify gets 502 and retries.
- A store the directory does not know: with peers configured, hooks answers **503** and stores nothing (it may be another region's fresh install); Shopify retries and the next sync resolves it. In a single-region deployment it is acknowledged `unknown_shop` as before.

## Confirm

In the deployment that received the webhook:

```sql
select kind, key, data_region, source, updated_at
from region_directory where key = '<shop>.myshopify.com';
```

- No row: the owning region has not published it — check that region's reconcile worker logs for `region directory synced` and `directory push failed` / `refused`.
- Row with the right region but forwards failing: the peer's hooks is down or `REGION_PEERS` points at the wrong URL (hooks env, JSON).
- `401` from `/internal/region-directory` in a peer's logs: the peer's `REGION_PEER_KEYS` entry for the sender is not the public half of the sender's `REGION_SYNC_PRIVATE_KEY`, or clocks differ by more than 5 minutes. `404`: the receiver has no `REGION_PEER_KEYS` at all. `409`: the snapshot was older than 10 minutes.

## Fix

- Wrong or missing peer URL: set `REGION_PEERS` on hooks and workers-reconcile in the tfvars (`common_env`), plan, apply (human-only, `deploy.md`).
- Key mismatch: re-copy the sender's public key into every peer's `REGION_PEER_KEYS` (tfvars `common_env`), plan, apply.
- A store moved regions (uninstalled in one, installed in another): the old owner releases it on its next pass; the new owner claims it on the pass after. Up to 10 minutes of webhooks are acknowledged `unknown_shop` in between — Shopify's hourly order reconcile (E-53) picks up missed orders.

## Keys

One Ed25519 key pair per region. Generate on the trusted machine:

```bash
node --import tsx -e "import('@naaradh/shared').then(m => console.log(m.generateRegionKeyPair()))"
```

- `privateKey` → Secret Manager `REGION_SYNC_PRIVATE_KEY` in **that region's** project only (held by `workers-reconcile`). Never copy it anywhere else.
- `publicKey` → the `REGION_PEER_KEYS` JSON in **every other** region's tfvars `common_env`, e.g. `REGION_PEER_KEYS = "{\"us\":\"<public key>\"}"` in prod-in. Public keys are not secrets.

Rotating: generate a new pair, put the new public key in the peers' tfvars and apply, then add the new private key version and redeploy the region's reconcile worker. Pushes signed with the old key fail with 401 in between (one or two sync passes).
