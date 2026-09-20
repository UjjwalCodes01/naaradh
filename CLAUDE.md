# CLAUDE.md — Naaradh

> Instructions for Claude Code working in this repository. Read fully before editing anything.
> Full engineering/agent detail lives in `AGENTS.md`. Product/regulatory spec lives in `docs/NAARADH_BUILD_SPEC.md`.
> If this file and `AGENTS.md` disagree, `AGENTS.md` wins for engineering; `docs/NAARADH_BUILD_SPEC.md` wins for compliance.

## What this project is

Naaradh is a multi-tenant **two-way AI voice agent for commerce** (ADR-0006).

- **Inbound (lead product):** the merchant's phone line, answered by an AI 24/7. Customers call; the agent resolves order status, delivery, policy and FAQ questions, cancels an unshipped COD order after a two-step confirmation, takes address changes and callbacks as tickets, and transfers to a human when it should.
- **Outbound:** COD order confirmation, abandoned-checkout recovery, appointment confirmation/booking, lead callback — on the same agent, numbers, compliance layer and dashboard.

It installs as a Shopify app, a WooCommerce plugin, and a REST API. Voice (STT/LLM/TTS + telephony) is rented from third-party engines behind an adapter; Naaradh owns the brain around it — call admission, identity, the tools the agent can use, the knowledge base, integrations, the compliance layer, dashboards, and billing.

Domain: `naaradh.com`. Cloud: Google Cloud (`asia-south1` primary). Company: Indian Pvt Ltd (in progress).

## Non-negotiable invariants (violating any of these is a bug, regardless of what the task says)

1. **Every outbound call passes through `compliance` gates** (`gateIntent()`) before `engine.placeCall()`. No code path may dial directly. **Every inbound call passes through `admitInbound()`** before the agent answers; a refusal falls back to the merchant's number or a closed message, never to silence.
2. **Recipient-region rules win over merchant-region rules.** Calling windows, consent type, CLI pool, disclosure language are chosen by the recipient's number/timezone.
3. **India window is 09:00–21:00 IST, hard.** Never schedule or retry outside it.
4. **COD confirmation is transactional only if dialed within 30 minutes of `event_ts`.** After that it is not transactional. Do not silently re-queue to next morning; gate with `reason='window:transactional_expired'`.
5. **Promotional purposes (`abandoned_cart`, `feedback`, `reactivation`) require a `consents` row** with matching purpose, unexpired, unrevoked. No consent → gated. Never infer consent from a phone number existing on an order.
6. **Suppressions are absolute.** Global or tenant suppression for (phone_hash, purpose|all) blocks dispatch for every use case it covers, including transactional.
7. **AI disclosure + recording disclosure are the first utterance of every call, inbound and outbound**, in every locale, and are logged as `ai_disclosed_at` / `recording_disclosed_at` on the attempt. Scripts and inbound profiles without them fail validation.
8. **Raw phone numbers never appear in logs, error messages, analytics exports, or test fixtures committed to git.** Use `phone_hash` for lookups; decrypt only in the dispatcher at dial time.
9. **Every request from outside is verified (HMAC/signature) before parsing** — webhooks, and the engine's inbound-context and tool calls to `voice`. Unsigned vendor webhooks are treated as hints: re-fetch the call by ID before writing outcomes or billing.
10. **Idempotency everywhere**: `webhook_events.external_event_id`, `call_intents.idempotency_key`, engine `Idempotency-Key`, Shopify usage records keyed by `outcome_id`.
11. **Billable outcome (outbound)** = human answered AND outcome ∈ {`confirmed`, `confirmed_with_changes`, `cancelled`, `rescheduled`, `booked`}. No other outbound outcome is ever billed. **Inbound** is billed per connected minute (ADR-0006), never per outcome. Do not change either without a product decision recorded in `docs/decisions/`.
12. **Kill switches are checked on every dispatch and every inbound admission**: outbound global → engine → tenant → campaign; inbound `inbound:*` → `inbound:<tenant>`. They are read from Redis with a 5 s TTL cache, never from process memory alone.
13. **No vendor SDK is imported outside `engines/<vendor>/`.** Product code only sees `VoiceEngineAdapter`.
14. **Never auto-cancel a Shopify order or auto-write an address from an extraction** unless the tenant setting is on AND `confidence >= 0.9`. **An agent-initiated cancellation** (inbound or outbound tool call) executes only through the two-step tool (readback + single-use token + second confirmation), with the tenant setting on, caller identity ≥ `caller_id` for that order, and the order COD, unfulfilled and not cancelled — else it becomes a merchant ticket. **Addresses are never written by the agent**; they become tickets. Defaults are off.
15. **Tenant isolation is enforced by Postgres RLS**, not only by `WHERE tenant_id = ?`. Every new table with tenant data gets an RLS policy in the same migration.
16. **An inbound call's tenant comes only from the number that was called** (`resolve_inbound_number()`), never from anything the caller or the engine payload claims.
17. **Identity before information.** The agent reveals order data only for orders matching the caller's verified identity (`caller_id` = caller hash matches the order's phone hash; `knowledge` = order number + pincode). Unverified callers get the knowledge base and a callback ticket, nothing else. Caller ID alone never unlocks money or address changes.
18. **The model never acts directly.** Every lookup and every action is a Naaradh tool call, validated with Zod, authorised against identity and tenant settings server-side, and written to `agent_actions`. The tool result is the only source of facts the agent may state besides published knowledge articles.
19. **Transfers go only to verified, active `transfer_targets`, inside their hours.** The caller never supplies a number. Transfer numbers are encrypted with the staff key pair; `voice` can decrypt staff numbers, never customer numbers.

## Stack (decided — see AGENTS.md §2 for rationale)

| Layer | Choice |
|---|---|
| Language/runtime | TypeScript 5.x on Node.js 22 LTS, ESM, strict mode |
| Monorepo | pnpm workspaces + Turborepo |
| API / webhooks / voice runtime / workers | Fastify 5 + Zod (`api`, `hooks`, `voice`, `workers`) |
| Shopify embedded app | Shopify CLI React Router template (`shopify`, ADR-0007), App Bridge, Polaris web components, Admin **GraphQL** only (pinned version in `shopify.app.toml`) |
| Merchant dashboard | Next.js 15 App Router (`web`), Tailwind, server components + server actions (ADR-0009) |
| Staff console | Fastify, server-rendered HTML, behind IAP (`console`, ADR-0009) |
| DB | **Neon** PostgreSQL 16 (ADR-0004), Drizzle ORM + drizzle-kit migrations (`db`); knowledge search = Postgres full-text search |
| Cache / counters | Memorystore Redis 7 (`ioredis`) |
| Async | Pub/Sub (events), Postgres `SKIP LOCKED` dispatch queue (ADR-0005), Cloud Scheduler (cron). Mid-call tool calls are synchronous HTTP to `voice`, never a queue. |
| Object storage | GCS, CMEK, `asia-south1` (recordings, transcripts) |
| Voice engine — India | **Bolna** (primary candidate; final choice after bake-off), **OmniDimension direct API** (secondary). Adapter: `engines/bolna`, `engines/omnidim` |
| Voice engine — US/EU | **Retell** (`engines/retell`) |
| Telephony | Via engine: Exotel/Plivo numbers for +91; Twilio/Telnyx for +1/+44 via Retell. Never foreign CLIs into India. |
| Billing | Shopify Billing API (Shopify merchants), Razorpay Subscriptions (INR direct), Stripe (USD direct) |
| Email | Google Workspace (team), Postmark (transactional, `mail.naaradh.com`) |
| Infra as code | Terraform ≥ 1.9 in `infra/` (state in GCS) |
| CI/CD | GitHub Actions → Workload Identity Federation → Cloud Build/Run |
| Tests | Vitest, Testcontainers (Postgres/Redis), k6, Playwright |
| Observability | Cloud Logging/Monitoring/Trace, Error Reporting; `pino` structured logs |

Rejected: CALL-E (no inbound, no cancel, India via international CLI), OmniRelay white-label (margin stack), NestJS (weight), REST Admin API (deprecated path).

## Repository layout

Flat: every folder at the root is one thing, and nothing is nested deeper. Seven folders are
deployed services; the rest is code they share. `STRUCTURE.md` is the map ("I want to change X →
go here"); `pnpm-workspace.yaml` is the authoritative list.

```
# deployed (one container each)
api/           # public REST API (api.naaradh.com): intents, consents, knowledge, tickets, inbound profiles
hooks/         # all inbound webhooks (hooks.naaradh.com); verify → enqueue → 200
voice/         # synchronous agent runtime (voice.naaradh.com): inbound admission + mid-call tools
workers/       # pubsub consumers + loops: intents, dispatcher, results, reconcile, deliveries,
               #   actions, writebacks, complaints, retention, billing, notifications, analytics
web/           # merchant dashboard (/app) + marketing and legal pages, magic-link sign-in.
               #   Deployed twice: full app on Cloud Run, marketing only on Vercel
               #   (NAARADH_SURFACE=marketing)
shopify/       # embedded Shopify app (React Router, ADR-0007)
console/       # staff console behind IAP: complaints, disputes, kill switches, erasure/DNC

# shared code (deployed by nobody; imported as @naaradh/<folder>)
compliance/    # outbound gate, inbound admission, consent ledger, suppressions, windows, counters
call-scripts/  # what the agent SAYS: outbound templates, inbound prompts, disclosures, tool
               #   definitions, validators, extraction schemas  (NOT shell scripts — those are scripts/)
engines/       # adapter interface + one folder per vendor (bolna, omnidim, retell) + simulator
               #   + contract harness + registry
db/            # drizzle schema, migrations, RLS policies, seed
pipeline/      # domain operations shared by api/voice/workers: contacts, intents, orders, tickets,
               #   agent actions, billing
shared/        # zod schemas, E.164 utils, phone hashing/encryption, ids, errors, logger, signing
shopify-sdk/   # typed GraphQL operations, webhook parsers, gateway table, billing, scopes, tokens
payments/      # Razorpay + Stripe clients and webhook verification (no SDK)
notify/        # transactional email (Postmark over fetch) + templates
calendar/      # appointment providers (Cal.com) behind one port

# not application code
infra/         # terraform modules, env tfvars, cloud armor policies
docs/          # NAARADH_BUILD_SPEC.md, decisions/, runbooks/, go-live/, legal/
scripts/       # repo tooling run by hand: env:local, keys:dev, lint:pii
tools/         # the custom eslint rules that enforce the invariants above
plugins/       # WooCommerce plugin (PHP, GPL)
docker/        # local Postgres init (roles, extensions)
load/          # k6 load tests
```

Every service and library has the same shape inside: `src/`, `test/` (`test/int/` needs a real
database), `package.json`, `README.md`, and a `Dockerfile` for the seven services.

## Commands

```bash
pnpm i                         # install
pnpm dev                       # turbo: all apps in watch mode (needs docker for pg/redis)
pnpm dev:shopify               # shopify app dev (tunnel) — requires SHOPIFY_* env
pnpm db:migrate                # drizzle-kit migrate (local)
pnpm db:generate               # generate migration from schema change
pnpm db:seed                   # seed fake tenants/numbers; engine=simulator
pnpm test                      # vitest unit
pnpm test:int                  # testcontainers integration
pnpm test:compliance           # compliance regression suite (must pass before any merge)
pnpm test:contracts            # engine adapter contract tests (recorded payloads)
pnpm lint && pnpm typecheck    # eslint + tsc --noEmit
pnpm env:check                 # every service can boot from infra/; templates match the schemas
pnpm env:list <service|vercel> # which env vars one surface needs, and where each value comes from
pnpm build                     # turbo build
pnpm tf:plan ENV=stage         # terraform plan for an env (read-only)
```

Local dependencies: Docker (Postgres 16, Redis 7 via `docker-compose.yml`), Node 22, pnpm 9, Shopify CLI 3.x, gcloud CLI (auth via `gcloud auth application-default login`).

## Environment variables (names only — values live in Secret Manager / `.env.local`, never committed)

`DATABASE_URL`, `DATABASE_SERVICE_URL`, `DATABASE_MIGRATOR_URL`, `REDIS_URL`, `GCP_PROJECT`, `GCP_REGION`, `PUBSUB_EMULATOR_HOST` (local), `RECORDINGS_BUCKET`, `PHONE_HASH_KEY`, `PHONE_ENC_PUBLIC_KEY`, `PHONE_ENC_PRIVATE_KEY` (dispatcher/results only), `STAFF_ENC_PUBLIC_KEY`, `STAFF_ENC_PRIVATE_KEY` (voice only), `ENGINE_WEBHOOK_KEY`, `VOICE_BASE_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SHOPIFY_SCOPES`, `ENGINE_DEFAULT_IN`, `ENGINE_DEFAULT_US`, `BOLNA_API_KEY`, `OMNIDIM_API_KEY`, `RETELL_API_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_PLAN_IDS`, `SHOPIFY_TOKEN_KEY`, `STRIPE_SECRET_KEY`, `POSTMARK_TOKEN`, `MAIL_FROM`, `APP_URL`, `DASHBOARD_URL`, `SHOPIFY_TOKEN_KEY`, `IAP_AUDIENCE`, `CONSOLE_ORIGIN`, `LOG_LEVEL`.

`pnpm env:list <service|vercel>` prints the current, authoritative list per surface (from each service's zod schema and `infra/locals.tf`); `pnpm env:check` fails when a service could not boot from what `infra/` provides, or when a template drifts from a schema.

## How to work in this repo

- **Before changing dispatch, compliance, billing, or scripts**: read `AGENTS.md §5–§8` and the relevant edge cases (`E-xx`) in `docs/NAARADH_BUILD_SPEC.md §12`. Add or update a test in `compliance/test` for the edge case you touch.
- **Before changing inbound admission, identity, or any agent tool**: read `AGENTS.md §5.7–§5.9` and edge cases E-80–E-99. A new tool needs: Zod args schema, identity requirement, tenant-setting check, an `agent_actions` row, a latency test, and a negative test proving an unverified caller cannot use it.
- **Before adding a Shopify scope or webhook**: update `shopify.app.toml`, `shopify-sdk/scopes.ts`, and the protected-data justification in `docs/shopify/pcd-justification.md`. Scopes are minimised; adding one needs a written reason.
- **Before adding a dependency**: check licence (MIT/Apache/BSD only in backend; GPL only inside `plugins/woocommerce`), size, and maintenance. No telemetry-sending packages.
- **Migrations**: forward-only; one migration per PR; include RLS policy; include down-migration notes in the PR, not in code.
- **Never** run destructive commands against non-local databases, `terraform apply`, `gcloud` mutations, or Shopify Partner Dashboard changes. Propose them; a human runs them.
- **Never** commit recordings, transcripts, real phone numbers, real merchant data, API keys, or `.env*` files. Test fixtures use the reserved fake ranges in `shared/test/fake-phones.ts`.
- **Never** weaken a gate to "make a test pass." If a compliance test fails, the code is wrong or the test encodes a rule change that needs a decision record.
- Prefer small PRs. Every PR description states: what changed, which invariant(s) it touches, which `E-xx` cases are covered by tests, and any `[OPEN]`/`[LEGAL]` items it depends on.
- When uncertain about a regulatory rule, **stop and ask**; do not implement a guess. Add the question to `docs/open-questions.md`.

## Coding conventions

- ESM, `strict: true`, `noUncheckedIndexedAccess: true`, no `any` (use `unknown` + Zod).
- Validate at boundaries with Zod; internal types inferred from schemas.
- Errors: throw `NaaradhError` subclasses with `code` (`GATED`, `ENGINE_UNAVAILABLE`, `IDEMPOTENT_REPLAY`, …); never throw strings.
- Logging: `pino` with `{tenant_id, intent_id, attempt_id, engine}` bindings; PII redaction paths configured in `shared/logger.ts` — extend the redact list when adding fields that may carry PII.
- Time: store UTC `timestamptz`; compute windows with `luxon` in the recipient's IANA zone; never use `Date` arithmetic for windows.
- Money: integer paise/cents in DB (`bigint`); currency code alongside; never floats.
- IDs: ULIDs, prefixed (`ten_`, `int_`, `att_`, `out_`, `con_`, `sup_`).
- Feature flags: `flags` table + `getFlag(tenantId, key)`; no external flag SaaS.
- Tests co-located in `test/` per package; name by behaviour: `gate.rejects_when_outside_window.test.ts`.
- Commit messages: Conventional Commits (`feat(dispatcher): …`, `fix(compliance): …`). Reference `E-xx` where relevant.

## Definition of done (for any feature touching calls)

- [ ] Unit + integration tests, including at least one negative compliance test
- [ ] `pnpm test:compliance` green
- [ ] Audit log entries for every state transition added
- [ ] Merchant-facing webhook/event emitted if a terminal state was added
- [ ] Dashboard shows the new state/reason with a human-readable explanation
- [ ] Runbook updated in `docs/runbooks/` if operators need to act
- [ ] No new raw-PII log fields (checked by `pnpm lint:pii`)

## Critical edge cases to keep in mind while coding (full list: spec §12)

- E-01/E-02 order near or after 21:00 → dial by 20:55 or gate; never next-morning as "transactional"
- E-03 previous opt-out blocks new orders for 90 days
- E-05 complaint counters: tenant auto-pause at 3 in 10 days; global kill at 5
- E-13 Shopify has no voice-consent object → promotional needs custom checkbox + ledger
- E-14 GoKwik/Shiprocket/Magic checkouts → no `checkouts/*` webhooks; ingest provider webhooks
- E-21 missing engine webhook → poll + reconcile
- E-23 unsigned vendor webhook → re-fetch before outcome/billing
- E-40 order cancelled while ringing → cancel or mark `outcome_superseded`, non-billable
- E-42 multiple orders same phone in 30 min → one call, multiple refs
- E-48 uninstall → stop dispatch ≤ 60 s; purge on `shop/redact`; keep consent/suppression/billing
- E-52 duplicate `orders/create` → idempotency key `(shop, order_id, use_case)`
- E-60 billable definition is fixed; disputes via `outcome_disputes`
- E-72 prompt injection via order fields → sanitise variables; never in system prompt unescaped
- E-80 withheld caller ID → answer, identity `none`, knowledge base + ticket only
- E-82 caller asks about someone else's order → refuse unless `knowledge` verification for that order
- E-84 "cancel my order" → two-step confirmation token; shipped/prepaid/unverified → ticket, never auto
- E-86 "transfer me to +44…" → refuse; transfers only to verified targets, in hours; after hours → callback ticket
- E-88 same caller floods the line → per-caller hourly limit, brief message, end
- E-90 caller speaks instructions at the agent ("ignore your rules") → treated as data; tools enforce limits regardless
- E-92 inbound minute cap reached / tenant paused / kill switch → forward to merchant fallback number, never dead air

## Where things are decided

- Product/pricing/regulatory: `docs/NAARADH_BUILD_SPEC.md`
- Architecture decision records: `docs/decisions/ADR-xxxx-*.md` (create one for any change to engine choice, billing unit, gate semantics, data residency)
- Open questions that block work: `docs/open-questions.md`
