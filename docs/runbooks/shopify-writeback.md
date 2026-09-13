# Shopify write-back — outcomes not reaching the merchant's orders

**Symptom:** the merchant says orders are not getting `naaradh:*` tags / notes; the dashboard shows outcomes with `writeback_status = failed`; logs have `shopify writeback gave up` or repeated `shopify writeback failed; will retry`.

## How it works

1. `finalizeAttempt()` (results-consumer) never calls Shopify. For an outbound call with an active Shopify integration it sets `writeback_status = pending`, `writeback_next_at = now`; otherwise `skipped`.
2. The **writebacks** worker (`WORKER=writebacks` or `all`) claims due rows with `SKIP LOCKED`. The claim pushes `writeback_next_at` 5 minutes ahead — a lease, so a crashed worker's row comes back on its own.
3. It rebuilds the plan from the outcome row and the tenant's **current** settings, then calls the Admin GraphQL API: `tagsAdd`, note (`orderUpdate`), `metafieldsSet` (namespace `naaradh`), and `orderCancel` only when auto-cancel is on and confidence ≥ 0.9. An already-cancelled order is not cancelled again. **No address is ever written** (Q-19).
4. Transient failures (429, `THROTTLED`, 5xx, network) retry in-process a few times, then at 2, 4, 8, 16, 32 minutes — at most 6 attempts. A revoked token (401/403), a store with no credentials, a malformed request or a Shopify refusal (`userErrors`) stops at once: `failed`, `writeback_next_at = null`, audit `outcome.writeback_failed`.

Only production writes to real stores (`SHOPIFY_WRITEBACK=live`, the default when `NODE_ENV=production`). Dev and CI record the plan instead.

## Look at it

```bash
psql "$DATABASE_SERVICE_URL" -c "
  select id, writeback_status, writeback_attempts, writeback_next_at, writeback_error
  from call_outcomes
  where tenant_id = '<ten_…>' and writeback_status in ('failed','pending')
  order by created_at desc limit 20"
```

| `writeback_error` starts with | Meaning | Action |
|---|---|---|
| `ShopifyAuthError` | Token revoked or a scope removed (merchant uninstalled/reinstalled, or changed app permissions). | Merchant reopens the app to re-authorise. Then re-queue (below). |
| `StoreNotConnectedError` | `integrations.credentials_secret_ref` is null. | Onboarding never stored the token — fix the install flow for that shop, then re-queue. |
| `ShopifyUserError: orderCancel …` | Shopify refused the cancel (e.g. already fulfilled, paid). The tags/note/metafields **did** land. | Nothing to retry. The merchant handles the order; the tag `naaradh:cod-cancelled` tells them the customer asked. |
| `ShopifyUserError: tagsAdd …` / `metafieldsSet …` | Order not found (deleted) or a value Shopify rejected. | Check the order exists; if it was deleted, leave it. |
| `ShopifyRequestError: Shopify GraphQL error …` | Our query does not match this API version's schema — **a bug**, affects every tenant. | Page engineering. Check `SHOPIFY_ADMIN_API_VERSION` against Shopify's deprecation notices. |
| `ShopifyRetryableError` with attempts = 6 | Shopify was down or throttling us for ~an hour. | Check status.shopify.com; re-queue once it recovers. |

## Re-queue

After the cause is fixed, put the rows back in the queue — the worker rebuilds the plan and the operations are idempotent, so re-running a partly-applied write-back is safe:

```sql
update call_outcomes
set writeback_status = 'pending', writeback_next_at = now(), writeback_attempts = 0, writeback_error = null
where tenant_id = '<ten_…>' and writeback_status = 'failed' and created_at > now() - interval '7 days';
```

Do not re-queue a `ShopifyUserError: orderCancel` row unless the order state changed — it will be refused again.

## Before switching a new environment to live

Run one outbound call on a **Shopify development store** with `SHOPIFY_WRITEBACK=live` and confirm in the admin: the tag, the note, the `naaradh.*` metafields on the order, and (with auto-cancel on and a cancelled outcome) the cancellation and its email. The client is built from shopify.dev's reference for the pinned version and tested against a fake endpoint; this is the step that proves it against the real one.
