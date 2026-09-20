# 11. The marketing site on Vercel

**Audience:** the founder. **Code state:** built and deployable today — the marketing pages are
the one surface that needs no account, no key and no database.

`naaradh.com` (the marketing pages, pricing, the legal pages) is served from Vercel. Everything
that touches merchant or customer data — the dashboard, sign-in, the public do-not-call form, the
API — runs on Cloud Run instead, from the same repository ([05](05-cloud-infrastructure.md)).

**Why the split:** the dashboard needs Memorystore Redis (rate limits, sign-in throttling, the
kill switches), and Memorystore is private to the GCP network. A Vercel deployment cannot reach
it. So the marketing deployment holds **no credential of any kind**, which is also the best
possible answer to "what happens if the marketing host is compromised".

## 1. The project

| Setting | Value |
|---|---|
| Framework preset | Next.js |
| Root directory | `web` |
| Install command | `pnpm install --frozen-lockfile` (run from the repo root; Vercel detects the workspace) |
| Build command | `pnpm build` |
| Node version | 22.x |
| Production branch | `main` |

The repo is a pnpm workspace, so `web` builds its workspace dependencies
(`@naaradh/pipeline` for the plan catalogue and the legal content, `@naaradh/shared`) from
source. Nothing else in the monorepo is built.

**Root directory is a project setting, not a file in the repo**, so moving the app in git does
not move it: a project created while the dashboard lived at `apps/web` keeps pointing there and
every deploy fails with "The specified Root Directory does not exist" until the setting is
changed (Project → Settings → Build and Deployment → Root Directory). Nothing in CI can catch
that — the Vercel check simply goes red on a commit whose code is fine.

## 2. Environment variables

Project → Settings → Environment Variables. Two, for **Production and Preview** both
(`web/.env.example`, or `pnpm env:list vercel`):

```
NAARADH_SURFACE=marketing
DASHBOARD_URL=https://app.naaradh.com
```

- `NAARADH_SURFACE=marketing` serves only the pages that need no backend. `/app`, `/auth`,
  `/login`, `/do-not-call` and `/api` are **not** served here: a GET is redirected (308) to the
  same path on `DASHBOARD_URL`, so a printed link keeps working, and anything else answers 404.
  Without this variable the deployment would try to open a database on those paths and return
  500s instead.
- `DASHBOARD_URL` is the dashboard's own origin. **Until the `web` Cloud Run service is enabled
  ([05](05-cloud-infrastructure.md) step 5), nothing serves those paths** — the redirect target
  404s. Do not print the `/do-not-call` URL on any notice until it does.

Nothing else. No `DATABASE_URL`, no `REDIS_URL`, no keys: if a variable like that is ever needed
here, something that should be on Cloud Run has moved to the wrong deployment.

## 3. Domains

| Domain | Points at |
|---|---|
| `naaradh.com`, `www.naaradh.com` | this Vercel project (www redirecting to the apex) |
| `app.naaradh.com` | the dashboard, Cloud Run — **not** Vercel |
| `api.` / `hooks.` / `voice.naaradh.com` | Cloud Run ([05](05-cloud-infrastructure.md)) |

DNS is Cloud DNS ([P0-INF-2](02-phone-numbers-and-dlt.md)), so add Vercel's records there rather
than moving the zone. Keep the CAA records in step if you add one: Vercel issues its own
certificates.

## 4. What to check after the first deploy

- [ ] `/`, `/product`, `/pricing`, `/pricing/us` and every legal page render
- [ ] `/healthz` answers `{"ok":true}`
- [ ] `/robots.txt` allows the marketing pages and disallows `/app`, `/login`, `/auth`, `/api`;
      on a **preview** deployment it disallows everything (a preview is a copy of the whole site
      on a throwaway hostname, and must never be indexed)
- [ ] `/sitemap.xml` lists the marketing and legal pages
- [ ] `/app` redirects to `app.naaradh.com/app` (or 404s while that service is off) — never a 500
- [ ] The response carries the Content-Security-Policy header (`middleware.ts`); the pages load
      no third-party script
- [ ] Prices on `/pricing` match `PLANS` (they are rendered from the same catalogue the ledger
      bills from, so they cannot drift)

## 5. What is deliberately NOT here

| | Where it lives | Why |
|---|---|---|
| Merchant dashboard (`/app`) | Cloud Run `web` | Needs the database, Redis and the phone-hash key |
| Sign-in (`/login`, `/auth`) | Cloud Run `web` | Magic links are rate-limited in Redis and stored in Postgres |
| Public do-not-call form | Cloud Run `web` | Writes a suppression; rate-limited per IP in Redis |
| Embedded Shopify app | Cloud Run `shopify` | Offline tokens sealed in Postgres (ADR-0007) |
| REST API, webhooks, voice runtime | Cloud Run | Tenant data, engine credentials, VPC-private stores |

Automatic deploys from `main` are safe for this surface: a marketing page cannot break a call,
and the pages hold no state. The Cloud Run services are deployed by hand instead
([deploy runbook](../runbooks/deploy.md)).
