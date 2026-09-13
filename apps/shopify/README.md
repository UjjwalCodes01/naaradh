# apps/shopify — the embedded Shopify app

Built on Shopify's **React Router** app template (ADR-0007): Polaris web components, App Bridge,
session-token auth, Admin GraphQL only. What it does:

| Route | |
|---|---|
| `/app` | Onboarding checklist and last-7-days summary |
| `/app/setup` | Business details, compliance declaration (clickwrap), spend cap, auto-cancel, **go live** |
| `/app/scripts` | Review and approve outbound scripts (disclosure re-validated) |
| `/app/support` | Support-line quick setup (language, hours, fallback number, on/off) |
| `/app/billing` | Shopify Billing API: recurring fee + capped usage line; approval in Shopify admin |

**Data access (ADR-0009).** The app connects as `naaradh_app` only. Sessions are stored through
`shopify_session_*()` SECURITY DEFINER functions, sealed with `SHOPIFY_TOKEN_KEY`
(`NaaradhSessionStorage`); installs go through `provision_shopify_install()` in the `afterAuth`
hook, which also adds the default use cases and draft scripts. Everything else runs under
`withTenant()` with the tenant resolved from the shop's integration row.

**Webhooks** are delivered to `apps/hooks`, not here (`shopify.app.toml`).

**Tokens.** Offline tokens expire hourly (`future.expiringOfflineAccessTokens`); the library
refreshes them for the app, and the workers refresh the same rows through
`apps/workers/src/shopify-tokens.ts`.

## Run

```bash
pnpm --filter @naaradh/shopify-app build     # react-router build
shopify app config link                       # a human, once per Partner app (staging / prod)
pnpm dev:shopify                              # shopify app dev — tunnel + dev store
```

Env: `DATABASE_URL`, `PHONE_HASH_KEY`, `STAFF_ENC_PUBLIC_KEY`, `SHOPIFY_API_KEY`,
`SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SHOPIFY_TOKEN_KEY` (32 bytes base64),
`SHOPIFY_BILLING_TEST`, `DASHBOARD_URL`. Refused: `DATABASE_SERVICE_URL` and any private key.

Stores outside India can install but see a waitlist screen (Q-20): calling exists only in India.
