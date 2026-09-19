# Naaradh

A compliance-first, two-way AI voice agent for commerce (ADR-0006). **Inbound first:** the agent
answers a merchant's support line, looks up the caller's orders, verifies strangers, cancels a COD
order only after a second "yes", creates tickets for what it may not do, and transfers to a
verified manager in hours. **Outbound:** COD confirmation, abandoned-checkout recovery,
appointment confirmation, lead callback — through the same gate, the same tools.

| Read this | For |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | **What is built and what is left, in one document** — start here if you are not writing code |
| [CLAUDE.md](CLAUDE.md) | The 19 invariants, conventions, definition of done. **Read before editing anything.** |
| [AGENTS.md](AGENTS.md) | Engineering reference: pipeline behaviour, gate order, contracts |
| [PLAN.md](PLAN.md) | Phased delivery plan and ticket ids |
| [docs/NAARADH_BUILD_SPEC.md](docs/NAARADH_BUILD_SPEC.md) | Product, pricing, regulatory spec; edge cases `E-xx` |
| [docs/open-questions.md](docs/open-questions.md) | What is unresolved, and the safe default until it is |
| [docs/go-live/](docs/go-live/README.md) | **Everything needed from outside the code to go live** — company, numbers and DLT, voice engine, Shopify Partner app, cloud, email, payments, secrets, first merchants |
| [docs/api/](docs/api/README.md) | The generated OpenAPI reference (`openapi.json`, also served at `/v1/openapi.json`) and the Client B quickstart |
| [docs/security/](docs/security/checklist.md) | SPEC §14 checklist with evidence, the 14 Sep 2026 implementation audit, VPC-SC evaluation, restore-drill log |
| [docs/decisions/](docs/decisions/) | ADRs — engine choice, billing unit, gate semantics, data residency, promotional calling (ADR-0010) |
| [docs/runbooks/](docs/runbooks/README.md) | What to do at 2 a.m., symptom first |

## Quick start

Needs Node 22 (`.nvmrc`), pnpm 9 (pinned via `packageManager` — corepack fetches it), Docker.

```bash
pnpm install
cp .env.example .env.local        # local-only values; never commit
pnpm services:up                  # Postgres 16, Redis 7, Pub/Sub emulator
pnpm dev                          # api :3001, hooks :3002, voice :3003
```

Local services use **non-default host ports** so they never collide with a Postgres or Redis
already on your machine:

| Service | Host port | Connect as |
|---|---|---|
| Postgres 16 | `55432` | `naaradh_app` (apps) · `naaradh_migrator` (migrations only) |
| Redis 7 | `56379` | — |
| Pub/Sub emulator | `8085` | `PUBSUB_EMULATOR_HOST=localhost:8085` |

`naaradh_app` is a non-owner `NOBYPASSRLS` role, so RLS genuinely applies to every application
query. Default grants are `SELECT, INSERT` only — tables are append-only unless a migration
opts them into `UPDATE`/`DELETE`. See [packages/db/README.md](packages/db/README.md).

## Checks

| Command | What | CI gate |
|---|---|---|
| `pnpm typecheck` | `tsc --noEmit`, strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | yes |
| `pnpm lint` | typescript-eslint strict type-checked + Naaradh rules (below) | yes |
| `pnpm lint:pii` | Repo-wide scan for raw phone numbers in **every** text file (JSON, SQL, CSV, MD…). Prints matches masked. | yes |
| `pnpm test` | Unit | yes |
| `pnpm test:compliance` | Compliance regression suite — **must pass before any merge** | yes |
| `pnpm test:contracts` | Engine adapter contract tests | yes |
| `pnpm test:int` | Testcontainers against real Postgres/Redis | yes |

Naaradh-specific lint rules, each enforcing an invariant mechanically:

- `naaradh/no-raw-phone-literal` — invariant 8. Only the reserved ranges in
  [packages/shared/test/fake-phones.ts](packages/shared/test/fake-phones.ts) may appear.
- `naaradh/no-pii-in-logs` — invariant 8. `logger.info({ phone })` fails; `{ phone_hash }` passes.
- `no-restricted-imports` — invariant 13. Vendor SDKs only inside `packages/engines/<vendor>/`.
- `no-restricted-syntax` in `packages/compliance` — no `new Date()` / `Date.now()`; windows go
  through luxon and the clock is injected so boundary tests can control it.

A deliberate out-of-range test number takes `// naaradh-pii-allow: <reason>` on its line; both
linters honour it.

## What exists (Phases 1–5)

| Area | State |
|---|---|
| Monorepo, toolchain, CI, lint rules, local services | done |
| `packages/db` — 46-table Drizzle schema, RLS with `app_tenant_id()` (raises, never silent), role split (app / service / migrator), append-only + immutability + billable + envelope triggers, Neon runbook (ADR-0004), Postgres-as-queue columns (ADR-0005) | done, 31 integration tests |
| `packages/shared` — phone normalise/hash/mask, RSA-OAEP encrypt (public key at ingestion, private key only in dispatcher/results), signing (Shopify HMAC, merchant webhooks, engine URL tags, API keys), logger redaction, money, clock | done |
| `packages/compliance` — the 13-step `gateIntent()` with full trace, windows in the recipient's zone (single-zone and coast-to-coast intersection), consent rules by region, `isBillable`, retry policy, Postgres + Redis adapters, consent/suppression/complaint ledger; inbound `admitInbound()`, identity, cancellation and transfer policies | done, 192 regression tests |
| `packages/scripts` — templates, disclosure validator (invariant 7), E-72 variable sanitiser, prompt renderer (variables never enter the system prompt), extraction schemas | done |
| `packages/engines` — adapter contract (outbound + inbound/tools surface), deterministic simulator with 19 scenarios (duplicate / out-of-order / missing / unsigned webhooks, 429, 5xx, timeout-after-send) plus an inbound conversation driver, shared contract harness, registry | done, 29 contract tests |
| `packages/pipeline` — contact upsert, `createIntent` (E-42/46/47/52/72, gated placeholders for E-43/E-26), cancellation, audit scrubbing, merchant-webhook outbox | done, 14 integration tests |
| `packages/shopify-sdk` — gateway normalisation (E-45), order + fulfilment webhook parsing tolerant of Level-2 nulls, Admin GraphQL client (429 / THROTTLED / 5xx retried, auth and schema errors loud, shop-domain allow-list) and idempotent order write-backs (`tagsAdd`, note, `metafieldsSet`, `orderCancel` guarded by `cancelledAt`) | done, tested against a fake Admin endpoint; live dev-store smoke test pending |
| `apps/hooks` — verify → dedupe → publish → 200; Shopify + engine routes; rejected bodies never stored; publish-failure retry path | done, 12 integration tests |
| `apps/workers` — intents-consumer, SKIP LOCKED dispatcher (attempt row committed before the dial), results-consumer (E-23 re-fetch, out-of-order, disclosure guard, E-34 recording persistence, billing ledger, suppressions, retries), reconcile (stale claims, stuck attempts, uncertain dispatch, expiry, concurrency repair), signed merchant deliveries with dead-lettering | done, 15-test end-to-end on Postgres + Redis + simulator |
| `plugins/woocommerce` — the WooCommerce connector (GPL-2.0-or-later): settings with its own diagnostics, consent checkbox, COD → intent, order cache, cart reporting, signed result webhook → order notes; never cancels or edits an order | done (ADR-0011 §3); listing on WordPress.org is human (Q-27) |
| `packages/calendar` — appointment calendars behind one port; no vendor SDK in product code | done, 12 tests |
| `apps/api` — API-key auth (secret + public site keys), scopes, per-key daily cap, `Idempotency-Key` replay, rate limits, `/v1/intents`, `/v1/consents`, `/v1/suppressions`, `/v1/calls/:id/recording`, `/v1/webhooks`; support line: `/v1/inbound-profiles`, `/v1/knowledge`, `/v1/transfer-targets` (staff key, attestation), `/v1/tickets`, `/v1/orders` | done, 24 integration tests |
| **Inbound (ADR-0006)** — `apps/voice`: `POST /inbound/:vendor` (tenant only from the called number; `admitInbound()` with forward/closed fallbacks, never dead air; idempotent on the vendor call id) and `POST /tools/:vendor/:tenantTag/:tool` (9 tools: lookup, verify, knowledge, confirm, two-step cancel, address change, ticket, transfer, opt-out — identity from the attempt row, Zod args, append-only `agent_actions`, retry replay). Order cache from Shopify webhooks; Hindi/Hinglish knowledge search; minute metering; inbound finalize; actions worker for approved cancellations; tools attached to outbound agents | done, 25-test end-to-end through voice + hooks + results on Postgres + Redis + simulator |
| Shopify write-back (P1-SHOP-2) | `writebacks` worker executes the plan after commit, backoff + give-up rules; `SHOPIFY_WRITEBACK=live` in production only; addresses never written (Q-19) |
| **Compliance layer (Phase 2)** — complaint intake + attribution + auto-pause (E-05), public do-not-call, erasure across tenants, retention sweep | done, `apps/workers/test/int/compliance.test.ts` |
| **Billing (Phase 2, ADR-0008)** — plan catalogue with allowances, `billing_postings` outbox to Shopify usage records / Razorpay add-ons, capped / frozen, disputes and credits, nightly reconciliation + margin | done, `apps/workers/test/int/billing.test.ts` |
| `apps/web` — merchant dashboard (magic-link sign-in, roles, orders, support calls, tickets, knowledge, agent, scripts, privacy, billing, team, API keys, access log) + public site and legal drafts | done (ADR-0009), domain tests in `packages/pipeline/test/int/dashboard.test.ts`, smoke-tested locally |
| `apps/shopify` — embedded app on the React Router template: install provisioning, onboarding, script approval, support-line setup, Shopify Billing approval; sessions sealed in Postgres | done (ADR-0007/0009); live dev-store run pending (P2-SHOP-8) |
| `apps/console` — staff console behind IAP: complaints, tenant resume/suspend, disputes, kill switches, global erasure/DNC | done, 9 integration tests |
| Workers additions — notifications (alerts + daily summary via Postmark), hourly Shopify order reconcile (E-53), expiring offline-token refresh | done |
| `infra/` Terraform — 13 modules, key-holder guard, Armor, monitoring, BigQuery dataset; Dockerfiles for all seven services; CI images + deploy workflows | `terraform validate` passes; nothing applied (a human applies) |
| **Promotional calling (Phase 4, ADR-0010)** — abandoned checkouts cached and swept (45-min idle, 24-h deadline, one call, 7-day cooldown per phone), consent only from Naaradh's own checkout/cart checkbox with the wording version in the ledger, DLT content template required on every Indian promotional script and copied onto each call, post-delivery feedback, script A/B with per-arm metrics, recovery attribution (measured, never billed), promotional-only pause on a promotional complaint, weekly 2% QA sample | done, `apps/workers/test/int/promotional.test.ts` (24 cases) + 192 gate regressions; **no promotional call can be placed** until a DND scrub provider (Q-02), counsel-approved wording (Q-08) and DLT templates (Q-23) exist |
| **Non-Shopify sources (Phase 5, ADR-0011)** — one cart-ingestion contract (`PUT /v1/carts/{ref}`, `POST /v1/carts/{ref}/completed`) that WooCommerce, one-click checkouts and bespoke stores all use, under the same promotional rules as ADR-0010; `plugins/woocommerce` (GPL) reports orders and carts server-side, adds the consent checkbox on the classic and block checkouts, and writes results back as order notes through a signature-verified REST route | done; PHP has no runner in CI, so its matrix is manual (`docs/go-live/09-woocommerce-and-appointments.md`) |
| **Appointments (Phase 5, ADR-0011)** — `packages/calendar` (port + Cal.com adapter `[VERIFY]` + deterministic fake), `get_slots`/`book_slot` agent tools that can only offer times the provider returned and only book against the caller's own number, one reminder call per appointment inside the −24 h/−2 h envelope, provider cancellations pushed from the reconcile tick, merchant Appointments page and staff Calendars page | done, 12 calendar unit tests + 8 tool cases in `apps/voice/test/int/voice.test.ts` + reminder/erasure cases in `apps/workers/test/int/promotional.test.ts` |
| Vendor adapters (Bolna / OmniDimension / Retell) | none, deliberately — the India engine is decided by the Phase 0 bake-off (ADR-0001) |

### Running the pipeline locally

```bash
pnpm keys:dev >> .env.local          # phone keys, engine webhook key, a Shopify secret
pnpm services:up && pnpm db:migrate && pnpm db:seed
pnpm --filter @naaradh/hooks dev     # :3002
pnpm --filter @naaradh/api dev       # :3001
pnpm --filter @naaradh/voice dev     # :3003 (in production it refuses to boot if PHONE_ENC_PRIVATE_KEY is mounted)
WORKER=all pnpm --filter @naaradh/workers dev
pnpm --filter @naaradh/web dev       # :3000 dashboard; sign-in links are logged in dev
CONSOLE_DEV_STAFF_EMAIL=you@naaradh.com pnpm --filter @naaradh/console dev   # :3004
```

Post a signed `orders/create` to `http://localhost:3002/shopify/webhooks` for the seeded shop
(`client-a-dev.myshopify.com`) with a number from the reserved fake ranges, and watch the
dispatcher pick it up two minutes after `created_at`.

### Calling the support line (simulator)

The seed gives Client A a support line on `+91 60xxx xx200` (profile `ipr_01SEEDASPPRT…`, Hindi
greeting, all nine tools, a verified manager, agent cancellation on) with two cached orders for
`FAKE_IN.customer`, and published knowledge articles. The simulator plays the engine: sign a
context request with `SIMULATOR_WEBHOOK_SECRET` and post it to `/inbound/simulator`; the answer
carries the greeting, the system prompt and the tool URLs to call next. `apps/voice/test/int/voice.test.ts`
is the executable walkthrough — every E-80…E-97 case is a named test there.
