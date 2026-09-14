# Shopify Admin API version upgrade (quarterly)

**Trigger:** Shopify releases a new Admin API version every quarter (January, April, July, October) and supports each for 12 months. Upgrade within two quarters of a release so the pinned version never expires (an expired version is silently served as the oldest supported one — behaviour changes without a deploy).

**Where the version is pinned (all must match):**

| Place | Setting |
|---|---|
| `apps/shopify/shopify.app.toml` | `api_version` (the app's webhook and GraphQL version) |
| `apps/shopify/shopify.app.staging.toml` | same |
| Workers env | `SHOPIFY_ADMIN_API_VERSION` (`infra/envs/*.tfvars` → `common_env`), default in `apps/workers/src/env.ts` |
| Shopify app env | `SHOPIFY_ADMIN_API_VERSION` in `apps/shopify/app/lib/env.server.ts` |
| `packages/shopify-sdk` | operations and tests written against that version |

## Steps

1. **Read the release notes** for the new version (developer changelog, "API version" page). List every change touching the operations in `packages/shopify-sdk/src/` (orders, fulfillments, metafields, billing/app subscriptions, usage records, customers) and the webhook topics in `shopify.app.toml`.
2. **Bump on a branch**: the four places above. Run `pnpm --filter @naaradh/shopify-sdk test` and `pnpm test:int` (the SDK's tests run against recorded responses; update fixtures where a field moved). Grep for deprecated fields the notes mention.
3. **Staging**: `shopify app deploy` with the staging config (registers the webhook subscriptions on the new version), deploy the workers and the app to stage, then run the dev-store subset (`docs/go-live/04-shopify-app.md` §6): fresh install, a COD order → intent, write-back (tags/note/metafields), billing approve + usage record, uninstall.
4. **Watch the deprecation headers** for a day: Shopify returns `X-Shopify-API-Deprecated-Reason` on calls using deprecated fields; the SDK logs them at warn level. Zero warnings before production.
5. **Production**: same order — `shopify app deploy` with the production config first (subscriptions), then the deploy workflow (workers, then app). Watch write-backs (`shopify-writeback.md`) and billing postings (`billing-postings.md`) for the first hour.
6. Record the version and date below.

## Rollback

Everything is a pin: set the previous version back in the four places, `shopify app deploy`, deploy. Webhook payloads already received on the new version stay in `webhook_events` as they came; the consumers parse both versions when a field was renamed (keep the compatibility branch for one quarter).

## History

| Date | From | To | Notes |
|---|---|---|---|
| 2026-09 | — | 2026-07 | initial pin (P1-SHOP) |
