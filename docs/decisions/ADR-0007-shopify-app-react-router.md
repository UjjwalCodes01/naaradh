# ADR-0007 — Shopify app on the React Router template, tokens encrypted in Postgres

**Status:** accepted
**Date:** 2026-09-12
**Deciders:** Founder (implemented by agent, per PLAN P2-SHOP-1)
**Invariants touched:** 9 (webhooks stay on hooks, HMAC-verified), 15 (new tables under RLS or service-only)
**Supersedes:** the "Shopify CLI Remix template, `@shopify/shopify-app-remix`" line in CLAUDE.md, AGENTS §2.4 and SPEC §8.1 (which were tagged `[VERIFY exact CLI/API versions at build time]`)

## Context

SPEC §8.1 asked to verify the template at build time. As of 2026, Remix has merged into React
Router 7 and Shopify's guidance is explicit: new apps use **Shopify App Template – React Router**
(`@shopify/shopify-app-react-router`), existing Remix apps migrate to it. The React Router package is
a fork of the Remix one (same `authenticate.admin`, `authenticate.webhook`, billing helpers) and
ships **Polaris web components**, which track Shopify admin's design automatically.

The template stores sessions with Prisma + SQLite. Naaradh already has Postgres (Neon, RLS roles,
Drizzle) and workers that must call the Admin API with the shop's **offline access token**
(write-backs, cancellations, billing usage records, hourly reconcile).

## Decision

1. `shopify` is built from the **React Router template**, UI in **Polaris web components**,
   Admin **GraphQL** only, API version pinned in `shopify.app.toml` (same version as
   `SHOPIFY_ADMIN_API_VERSION` for workers).
2. **No Prisma.** Sessions live in Postgres table `shopify_sessions`, accessed through a
   Naaradh `SessionStorage` implementation over the service role (the app's auth path is
   pre-tenant, like hooks). The **access token is encrypted at rest** with AES-256-GCM under
   `SHOPIFY_TOKEN_KEY` (32 bytes, Secret Manager in prod); the table stores ciphertext, IV and tag,
   never the token. App role has no grant on the table.
3. `integrations.credentials_secret_ref` for a Shopify store becomes
   `shopify-session:offline_<shop>`; workers resolve it through the same `SecretResolver`
   interface, which decrypts from `shopify_sessions`. Only services that call Shopify mount the key:
   `shopify`, workers roles `writebacks`, `actions`, `billing`, `reconcile`.
4. **Webhooks are not handled by the app.** `shopify.app.toml` declares every topic (incl. the
   three mandatory compliance topics) with `uri = https://hooks.naaradh.com/shopify/webhooks`;
   hooks already verifies HMAC, returns 401 on a bad one, dedupes and publishes (invariant 9). One
   webhook receiver, one code path.
5. Per-shop Secret Manager secrets were rejected: N secrets with per-secret IAM, an extra network
   hop on every token read, and no local equivalent (dev would need GCP to install the app).

## Consequences

- CLAUDE.md / AGENTS §2.4 / SPEC §8.1 updated to "React Router template".
- New migration: `shopify_sessions` (service-only grants, no RLS policy needed because the app
  role cannot reach it — the RLS completeness test is told so explicitly).
- Rotating `SHOPIFY_TOKEN_KEY` is a re-encryption job (kid column), not a config flip.
- Losing `SHOPIFY_TOKEN_KEY` means every store must re-open the app (token exchange re-issues
  tokens) — recoverable, not data loss.
