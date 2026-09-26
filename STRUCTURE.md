# Where is the code for…?

Every folder at the root is one thing. **Seven of them get deployed** (each becomes its own
container); the rest is code those seven share. Nothing else is nested — if you are looking for
something, it is one folder deep.

## The seven services (deployed)

| Folder | What it is | Runs where |
|---|---|---|
| **`api/`** | The public REST API a merchant's own systems call: create a call, record consent, manage knowledge and tickets. | `api.naaradh.com` |
| **`hooks/`** | Receives webhooks from other people — Shopify orders, the voice vendor, Razorpay, Stripe. Verifies the signature, queues the work, answers 200. Nothing else. | `hooks.naaradh.com` |
| **`voice/`** | The brain during a live call: decides whether to answer an incoming call, and answers the agent's mid-call questions ("what is this order's status?"). Must reply in well under a second. | `voice.naaradh.com` |
| **`workers/`** | Everything that happens in the background: placing calls, writing down results, billing, retries, reminders, cleanup. One folder, many jobs (`WORKER=dispatcher`, `WORKER=billing`, …). | Cloud Run, no public URL |
| **`web/`** | Two things in one app: the **merchant dashboard** (`/app`) and the **public website** (home, pricing, legal). | dashboard on `app.naaradh.com`; website on Vercel |
| **`shopify/`** | The app a merchant installs inside Shopify admin: onboarding, settings, plan approval. | `shopify.naaradh.com` |
| **`console/`** | Staff-only screens for us: complaints, disputes, kill switches, numbers, erasure requests. Behind Google sign-in. | `console.naaradh.com` |

## The shared code (deployed by nobody)

| Folder | What it holds | The one-line reason it exists |
|---|---|---|
| **`compliance/`** | The gate every outbound call passes through, calling hours per country, consent, suppressions, do-not-call screening, spend caps. | "May we place this call?" is answered in exactly one place. |
| **`call-scripts/`** | What the AI actually **says**: prompts, the AI + recording disclosure, the tools it may use, and the shape of the result. | The words are reviewed and versioned separately from the code. |
| **`engines/`** | One folder per voice vendor (`bolna`, `omnidim`, `retell`), plus `simulator` for tests, all behind one contract in `engines/core`. | Swapping vendors must not touch product code. |
| **`db/`** | Tables, migrations, row-level security policies, seed data. | One schema, one place migrations live. |
| **`pipeline/`** | Shared business operations: orders, call intents, tickets, billing, dashboards. Used by `api`, `voice` and `workers`. | So three services cannot each implement "cancel an order" differently. |
| **`shared/`** | Small utilities: ids, errors, logging, phone hashing and encryption, request signing. | Used by everything; holds no business rules. |
| **`shopify-sdk/`** | Typed Shopify Admin API calls, webhook parsers, billing. | The only place that knows Shopify's API shape. |
| **`payments/`** | Razorpay (rupees) and Stripe (dollars) clients and webhook verification. | — |
| **`occ/`** | One-click checkout providers (GoKwik, Shiprocket, Razorpay Magic, Cashfree): webhook verification and cart mapping. | Those checkouts replace Shopify's, so abandoned carts must come from the provider (E-14). |
| **`crm/`** | CRM lead sources (Zoho, HubSpot): webhook verification and lead mapping. | A new lead should be called back while it is warm. |
| **`notify/`** | Transactional email (Postmark) and its templates. | — |
| **`calendar/`** | Appointment providers (Cal.com) behind one port. | — |

## Everything else at the root

| Folder | What it is |
|---|---|
| `docs/` | The spec, decisions (`docs/decisions/`), runbooks for when something breaks (`docs/runbooks/`), and the go-live guides (`docs/go-live/`) |
| `infra/` | Terraform: the cloud setup. `infra/envs/*.tfvars` is one file per environment |
| `scripts/` | Repo tooling you run by hand: `pnpm env:local`, `pnpm keys:dev`, `pnpm lint:pii`, `pnpm lint:context` |
| `tools/` | The custom lint rules that enforce the invariants in CLAUDE.md |
| `plugins/` | The WooCommerce plugin (PHP) |
| `docker/` | Local Postgres setup for development |
| `load/` | Load tests (k6) |

## Inside a service or a library

Always the same shape, so once you know one you know all of them:

```
<folder>/
├── src/            the code
├── test/           its tests      (test/int/ = tests that need a real database)
├── package.json    its name (@naaradh/<folder>) and dependencies
├── Dockerfile      services only: how the container is built
└── README.md       what this folder is
```

## "I want to change X"

| I want to… | Go to |
|---|---|
| change what the agent says on a call | `call-scripts/src/` |
| change when we are allowed to call someone | `compliance/src/` |
| add a field to the database | `db/src/schema/`, then `pnpm db:generate` |
| change what the merchant sees | `web/src/app/app/` |
| change the public website or pricing page | `web/src/app/(site)/` |
| change how a call is placed or retried | `workers/src/dispatcher/` |
| change what happens after a call ends | `workers/src/results/` |
| add a voice vendor | a new folder in `engines/`, then `engines/registry/` |
| change billing | `pipeline/src/billing/` and `workers/src/billing/` |
| add an API endpoint | `api/src/routes/`, then `api/src/openapi.ts` |
| handle a new Shopify webhook | `shopify.app.toml`, `hooks/src/routes/shopify.ts`, `workers/src/intents/consumer.ts` |
| change what an environment variable does | that folder's `src/env.ts`, then `pnpm env:check` |

## Two things worth knowing

- **`call-scripts/` is not shell scripts.** It is what the AI says out loud. Repo tooling you run
  by hand lives in `scripts/`.
- **`web/` is deployed twice** from the same code: the full app (dashboard + website) on Cloud
  Run, and the website only on Vercel, where `NAARADH_SURFACE=marketing` switches the dashboard
  off. See [docs/go-live/11-marketing-site-vercel.md](docs/go-live/11-marketing-site-vercel.md).

The authoritative list of workspace folders is `pnpm-workspace.yaml`; the lint rules that depend
on these paths are listed in `eslint.config.js` (`WORKSPACES`).
