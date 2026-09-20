# ADR-0009 — Merchant surfaces: dashboard sign-in, staff console, Shopify app data access

**Status:** accepted
**Date:** 2026-09-13
**Deciders:** Founder (implemented by agent, per PLAN Phase 2 — P2-WEB-1, P2-SHOP-1…3, P2-OPS)
**Invariants touched:** 8 (numbers masked everywhere), 15 (RLS; who may hold BYPASSRLS), 19 (staff key)
**Amends:** ADR-0007 decision 2 ("sessions … accessed through … the service role") — the Shopify app
now reaches `shopify_sessions` through SECURITY DEFINER functions instead (below).

## Context

Phase 2 adds three surfaces people log into: the merchant dashboard (`web`), the embedded
Shopify app (`shopify`) and a staff console. Each needs to act before a tenant is known
(sign-in, loading a Shopify session, provisioning a new store) and then act within one tenant.
`db/src/service.ts` and the lint rule already say the BYPASSRLS role never serves a
merchant request. AGENTS §4 lists who may hold the customer private key (dispatcher, results,
reconcile) and AGENTS §3 promised a dashboard "reveal number" action.

## Decision

1. **One domain layer, three surfaces.** Tenant operations used by more than one surface live in
   `@naaradh/pipeline` (`admin/*` for configuration shared with the API, `dashboard/*` for read
   models and team/settings rules). Surfaces authenticate, parse and render. An `Actor`
   (`api_key` | `user`) makes the audit trail identical whichever surface made a change.

2. **Merchant dashboard sign-in = magic links.** No passwords. A login token is 32 random bytes,
   stored as SHA-256, valid 15 minutes, spent once (`consume_login_token()` — one UPDATE … WHERE
   used_at IS NULL). Sessions are opaque 32-byte cookies (`__Host-` prefix in production, HttpOnly,
   SameSite=Lax), stored hashed, 7-day absolute and 12-hour idle lifetime, revoked on sign-out,
   "sign out everywhere" and user removal. The emailed link opens a page with a button (POST), so
   mail scanners that fetch links cannot spend the token. Rate limits per address and per network
   fail closed. The answer to "send me a link" is identical whether or not the address exists.

3. **Pre-tenant steps are SECURITY DEFINER functions, not the service role.** Migration 0009 adds
   `web_login_candidates`, `create_login_token`, `consume_login_token`, `resolve_web_session`,
   `shopify_session_store/load/delete`, `shopify_sessions_for_shop` and `provision_shopify_install`,
   granted to `naaradh_app` only. `login_tokens` and `shopify_sessions` have no app-role grants;
   `shopify_sessions` has RLS forced with no policy. The dashboard and the Shopify app therefore run
   entirely as `naaradh_app`; their env schemas refuse `DATABASE_SERVICE_URL`.

4. **Roles** (dashboard): viewer < operator < manager < owner. Recordings and transcripts need
   operator; settings, agent, scripts and team need manager; API keys and billing need owner. There
   is always one owner. **Inside Shopify admin** every user acts as owner: Shopify's staff
   permissions already decide who can open the app, and the embedded app exposes only onboarding,
   settings, scripts and billing; per-person roles live in the dashboard.

5. **Numbers stay masked; "reveal" is not built.** Revealing needs the customer private key, and no
   merchant-facing service may hold it. AGENTS §3's reveal action waits for a KMS-backed decrypt
   (Cloud KMS asymmetric key; a narrow decrypt permission for one service account, every call
   audited). Merchants have the full number in their store admin; the dashboard shows the order
   reference beside the masked number.

6. **Media access is audited before it is served.** `accessMedia()` writes `recording.accessed` /
   `transcript.accessed` to `audit_log`, then the dashboard redirects to a 15-minute GCS signed URL
   (`<audio preload="none">` so nothing is fetched until play). Merchants see these rows on the
   access log page (E-74).

7. **Staff console = its own small service** (`console`): Fastify, server-rendered HTML with
   no client script, behind Identity-Aware Proxy. The IAP JWT is verified in-process (ES256, `aud`
   = the backend service, issuer, expiry) and the email checked against a staff domain/allow-list.
   It holds the service role (cross-tenant is its job) and nothing else sensitive; every POST must
   be same-origin; every action is audited as `staff:<email>`. It is the only place that resumes a
   complaint-paused tenant, suspends one, decides disputes, flips kill switches and files global
   erasure / do-not-call requests from the dnc@ and privacy@ mailboxes.

8. **Shopify installs provision themselves.** `afterAuth` reads the shop and calls
   `provision_shopify_install()` (advisory-locked per shop): first install → tenant `pending_review`
   for 7 days + integration + owner user; reinstall → lifts only the `app/uninstalled` pause; a
   complaint, billing or staff pause stays. Default use cases (OFF) and draft scripts are added so
   onboarding has something to approve. Going live needs the compliance declaration, an approved
   script and an active plan.

9. **Stores outside India** can install but get a waitlist screen; their tenant is created with the
   data region of their country and no calling is set up (Q-20).

## Consequences

- Sign-in depends on email delivery (Postmark). Production refuses to boot the dashboard or the
  notifications worker without a Postmark token.
- Any service with `naaradh_app` credentials can call the definer functions (including creating a
  tenant for a shop domain). Holding those credentials is already a full breach of the app tier;
  the functions validate their inputs and write audit rows.
- The console is a second codebase for internal UI, deliberately plain; it does not share the
  dashboard's components.
- The dashboard uses a small Tailwind component set (`web/src/components/ui.tsx`) instead of
  shadcn/ui (CLAUDE.md stack table): server components need no client UI library, and the only
  client component is the form wrapper. Adopt shadcn/ui if the dashboard grows interactive
  widgets (date pickers, command menus).
- Revisit (5) when the KMS decrypt path exists; revisit (4) if merchants ask for per-staff roles
  inside Shopify admin (online sessions would provide the user).
