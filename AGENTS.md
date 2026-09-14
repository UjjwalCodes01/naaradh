# AGENTS.md — Naaradh engineering guide for AI coding agents

This file is the authoritative engineering reference for any AI agent (Claude Code, Codex, Cursor, etc.) working in this repository. `CLAUDE.md` is a shorter, Claude-specific entry point that defers here. The product/regulatory source of truth is `docs/NAARADH_BUILD_SPEC.md` (referred to as **SPEC**); edge cases are numbered `E-xx` there and referenced here.

Tags used below: `[VERIFIED]` primary-source fact · `[VERIFY]` confirm before relying · `[DECISION]` chosen, changeable via ADR · `[LEGAL]` lawyer/CA sign-off required · `[OPEN]` unresolved — do not assume.

---

## 1. Mission and scope for agents

You are helping build a **compliance-first, two-way AI voice agent for commerce** (ADR-0006): it answers a merchant's customers when they call (inbound, the lead product) and places outbound calls (COD confirmation, lead callback, …). The hardest part of this system is not the voice. Outbound: never make a call that should not have been made, and always be able to prove why each call was made. Inbound: never tell a caller something they are not entitled to know, never let the agent *do* something the merchant did not allow, and never leave a caller in dead air. Optimise for correctness, auditability, idempotency and latency over cleverness.

Agents may: implement features, write tests, refactor within conventions, write migrations, write Terraform *plans*, update docs, draft runbooks.

Agents may not (propose instead): apply Terraform, run `gcloud` mutations, touch Shopify Partner Dashboard, change billing enums, change gate semantics, add Shopify scopes, add a voice vendor, delete data, or merge without human review.

---

## 2. Tooling decisions and rationale `[DECISION unless noted]`

### 2.1 Voice engines (the "calling" tools)

| Role | Tool | Why | Adapter package |
|---|---|---|---|
| India primary | **Bolna** | India-first (Hindi/Hinglish/vernacular), Exotel/Plivo integration, call transfer, Cal.com slot tools, bulk API; reported ≈ ₹5.5/min `[VERIFY]`; final selection after bake-off (SPEC §15.1) | `packages/engines/bolna` |
| India secondary | **OmniDimension** (direct API, *not* OmniRelay) | +91 numbers via eKYC, Exotel import, SIP; model-agnostic; retail $0.084→$0.035/min `[VERIFIED docs]`; no DLT features — compliance is ours | `packages/engines/omnidim` |
| US/EU | **Retell** | Strong inbound, warm transfer with context summary, Cal.com booking tools, HIPAA BAA, SOC 2 `[VERIFIED]`; $0.07/min + LLM + telephony ≈ $0.13–0.31 all-in | `packages/engines/retell` |
| Local/test | **Simulator** | Deterministic scripted events for CI | `packages/engines/simulator` |
| Rejected | CALL-E, Vapi (v1), self-hosted LiveKit/Pipecat (v3+) | See SPEC §5.2 | — |

Selection at runtime: `tenants.engine_override` → else by recipient region (`+91`→`ENGINE_DEFAULT_IN`, `+1/+44/EU`→`ENGINE_DEFAULT_US`). Failover to secondary only if `tenants.multi_engine_ok = true` and the primary is circuit-open. **Inbound** uses whichever engine the called number is attached to (`numbers.engine`).

**Hard requirements for any engine we adopt (ADR-0006):** inbound calls on numbers it hosts, an inbound-context webhook (we choose the prompt/variables per call), mid-call HTTP tool calls with a timeout we can set, transfer to an arbitrary E.164 we return, signed requests (or a shared secret we can verify). The bake-off (ADR-0001) scores inbound latency and tool round-trips on real Indian networks, not only outbound.

### 2.2 Telephony

- +91 numbers: purchased/imported through the engine from **Exotel** or **Plivo** (Indian licensed CPaaS). Numbers are stored in `numbers` with `series` (`140` | `1600` | `10digit` | `intl`) and `purpose_allowed[]`. **The `series` for non-BFSI service calls is `[OPEN]`** — until TSP letters are on file, `purpose_allowed` for any +91 number must be set by a human, never defaulted in code.
- +1/+44/EU numbers: via Retell (Twilio/Telnyx). Never used to dial +91.
- **Inbound numbers** (a merchant's support line): 10-digit Indian virtual numbers from Exotel/Plivo attached to the engine; `numbers.inbound_enabled = true`, `numbers.tenant_id` = the merchant, `numbers.inbound_profile_id` = which agent answers. Merchants can also **forward their existing number** to it. Whether answering and transferring on such a number carries DLT/TCCCPR obligations is `[OPEN]` Q-15.
- Validation: E.164 via `libphonenumber-js`; Indian mobiles must match `^\+91[6-9]\d{9}$`; reject premium/short codes; number-type lookup cached 30 days.

### 2.3 Platform and data

- GCP `asia-south1` (Mumbai) primary; separate projects per env; `us-central1`/`europe-west1` projects for those markets later. Data region is a tenant attribute; rows/objects never cross regions.
- Cloud Run (all services; `voice` with min instances ≥ 2 and CPU always allocated — a cold start mid-call is dead air), **Neon Postgres 16** (ADR-0004: pooled + direct endpoints, Singapore, Q-16), Memorystore Redis 7, Pub/Sub, Cloud Scheduler, GCS (CMEK), Secret Manager, KMS, BigQuery, Cloud Armor + Global LB + Certificate Manager, Cloud DNS. Outbound dispatch is a Postgres queue (ADR-0005), not Cloud Tasks.
- Terraform for everything under `infra/`; no click-ops. Agents produce plans only.

### 2.4 Application stack

- Node 22 LTS, TypeScript 5 strict, ESM, pnpm 9, Turborepo.
- `apps/api`, `apps/hooks`, `apps/voice`, `apps/workers`: Fastify 5, Zod, `pino`, `ioredis`, `@google-cloud/pubsub`, `@google-cloud/storage`, `luxon`, `libphonenumber-js`, `ulid`.
- `apps/shopify`: Shopify CLI React Router template, `@shopify/shopify-app-react-router`, App Bridge, Polaris web components, Admin GraphQL (pinned `api_version` in `shopify.app.toml`, upgraded quarterly). Sessions in our own `shopify_sessions` table, token encrypted (ADR-0007) — no Prisma.
- `apps/web`: Next.js 15 App Router, Tailwind, server components and server actions (no client data fetching library; one client component for forms). Magic-link sign-in (ADR-0009).
- `apps/console`: Fastify + server-rendered HTML behind IAP; the one merchant-data UI that holds the service role (ADR-0009).
- `packages/db`: Drizzle ORM, drizzle-kit, RLS helpers.
- Payments: Shopify Billing API (mandatory for Shopify-installed merchants `[VERIFIED]`), Razorpay Subscriptions (INR), Stripe (USD).
- Email: Postmark; team mail Google Workspace.
- Tests: Vitest, Testcontainers, k6, Playwright. Lint: ESLint (typescript-eslint strict), Prettier, custom `lint:pii` rule.

### 2.5 Third-party integrations roadmap

Shopify (v1) → REST API + JS snippet (v1) → WooCommerce plugin (v2, GPL, `plugins/woocommerce`) → Zoho CRM, HubSpot (v2) → Cal.com, Google Calendar (v2) → Zapier/Make/n8n (v2) → Indian one-click checkout providers GoKwik/Shiprocket/Razorpay Magic/Cashfree abandoned-cart webhooks (v1.5, `[OPEN]` partner access).

---

## 3. Repository map and ownership

```
apps/api         public + admin REST (Fastify). Owns: auth, API keys, intents API, consents API, suppressions API, recordings signed URLs, merchant webhooks registry, knowledge articles, support tickets, inbound profiles, transfer targets.
apps/hooks       inbound webhooks only. Owns: signature verification, dedupe, publish to Pub/Sub. Must respond < 800 ms p99. No business logic here.
apps/voice       synchronous agent runtime (voice.naaradh.com). Owns: inbound admission (who answers, or fallback), per-call prompt/tools/variables, every mid-call tool (identity, orders, knowledge, cancellation, tickets, transfer, opt-out). p95 < 500 ms context / < 700 ms tools. Holds the staff decryption key, never the customer one.
apps/workers     Pub/Sub consumers + loops:
                   intents-consumer   shopify/woo/api events → call_intents; order cache (orders) for inbound lookups
                   dispatcher         gates → placeCall → call_attempts
                   results-consumer   engine events → attempts/outcomes → writebacks → billing (outcomes outbound, minutes inbound)
                   writebacks         outcome → Shopify tags/note/metafields/cancel, outside any transaction, retried (P1-SHOP-2)
                   actions            approved agent actions (e.g. cancellation) → Shopify write-back; every guard re-checked at execution; backoff 2^n min; dead after 5 → ticket (runbook agent-action-failed.md)
                   deliveries         signed merchant webhooks, backoff, dead letter
                   billing            ledger → billing_postings → Shopify usage records / Razorpay add-ons; subscription sync (webhooks are hints, re-fetched); capped / frozen; nightly reconciliation + margin (ADR-0008)
                   reconcile          stale claims, stuck attempts, uncertain dispatch, expiry, concurrency repair (E-21); hourly Shopify orders the webhooks missed (E-53)
                   retention          erasure requests (media + rows, tombstones kept); recordings/transcripts lifecycle; order-cache retention
                   complaints         complaint_reports → attribution → counters → auto-pause (E-05) / global kill
                   notifications      merchant email: alerts queued with merchant events (complaint, pause, billing) + daily summary (P2-WEB-4)
apps/shopify     embedded app UI (React Router, ADR-0007) + OAuth + Billing API approval flow. Webhooks, incl. compliance topics, go to apps/hooks.
apps/web         dashboard (calls, transcripts, recordings, tickets, knowledge, agent, scripts, privacy, billing, team, API keys, access log), marketing site, public pages (/privacy, /terms, /dpa, /aup, /do-not-call, /security, /subprocessors, …). App role only.
apps/console     staff console (IAP): complaints, tenant resume/suspend, disputes, kill switches, global erasure/DNC. Service role; every action audited as staff:<email>.
packages/compliance  THE gate (outbound gateIntent) and admission (inbound admitInbound), consent ledger, suppression list, windows, complaint counters, DND scrub client, disclosure validators.
packages/engines     VoiceEngineAdapter interface (calls, inbound context, tool calls), vendor adapters, simulator, contract-test harness, registry.
packages/db          schema, migrations, RLS, seed, typed queries.
packages/shared      zod schemas, ids, errors, logger, phone utils (hash/encrypt, customer + staff key pairs), money utils, time utils, signing.
packages/scripts     outbound script templates, inbound agent profiles → prompts, tool definitions, per-locale disclosure lines, validators, variable sanitiser (E-72), extraction schemas.
packages/pipeline    domain operations used by api, voice and workers: contacts, intents, cancellation, order cache, identity, knowledge search, tickets, agent actions, audit, merchant-webhook outbox.
packages/shopify-sdk typed GraphQL documents, webhook payload parsers, tag/note/metafield writers, billing, scopes, expiring-token refresh, hourly order listing.
packages/notify      Postmark mailer + email templates (no customer data in any email).
packages/payments    Razorpay Subscriptions client + webhook signature verification.
infra/               terraform: network, cloudrun, cloudsql, redis, pubsub, gcs, kms, armor, dns, iam, monitoring.
docs/                SPEC, ADRs, runbooks, legal drafts, open-questions.md, shopify/pcd-justification.md.
```

---

## 4. Data model rules

Schema is defined in `packages/db/schema/*.ts` and mirrors SPEC §6.5. Rules:

- Every tenant-scoped table: `tenant_id` NOT NULL + RLS policy `USING (tenant_id = app_tenant_id())` — the function raises when the context is unset (ADR-0004). The API, voice runtime and workers set `app.tenant_id` per transaction via `withTenant(db, tenantId, fn)`. Only documented cross-tenant queries use the service role (dispatcher claim, reconcile, hooks, deliveries).
- Append-only tables (`consents`, `audit_log`, `billing_ledger`, `agent_actions`): no `UPDATE`/`DELETE` for app roles, enforced by grants and triggers; corrections are new rows. `suppressions` may only be lifted.
- Phone handling: `contacts.phone_hash = HMAC_SHA256(PHONE_HASH_KEY, e164)`; `contacts.phone_enc = RSA-OAEP(PHONE_ENC_PUBLIC_KEY, e164)`. Ingestion (api, voice, intents-consumer) holds only the public key. Only `dispatcher`, `results-consumer` and `reconcile` hold `PHONE_ENC_PRIVATE_KEY`. **Transfer targets** use a separate staff key pair (`STAFF_ENC_*`): `apps/voice` holds the staff private key so it can transfer a call, and cannot decrypt customer numbers. Dashboard shows masked numbers (`+91 98xxx xx123`). A manager "reveal" is deferred until a KMS-backed decrypt exists: no merchant-facing service may hold the customer private key (ADR-0009).
- **Order cache** (`orders`): minimal fields for inbound lookups only — order number, statuses, total, item summary, tracking, `phone_hash`, `pincode_hash`. No names, no addresses, no line-level PII. Erased with the contact.
- Money: `bigint` paise/cents + `currency` char(3).
- Enums are Postgres enums; adding a value is a migration + ADR if it affects billing or gating.
- Retention: `tenants.retention_days` (30–365, default 90) applies to recordings/transcripts; consents/suppressions/audit/billing retained ≥ 3 years `[LEGAL]`.
- Erasure (`erasure_requests`): by `phone_hash` across recordings (GCS delete), transcripts, `contacts`, `call_attempts.transcript_uri` → replaced with tombstone; consents/suppressions kept as legal record with PII minimised `[LEGAL]`.

---

## 5. Call pipeline — exact behaviour

### 5.1 Intent creation (`intents-consumer`)

Input events: `shopify.orders.create`, `shopify.checkouts.update`, `provider.abandoned_cart` (GoKwik etc.), `api.intents.create`, `woo.order.create`, `crm.lead.create`, `calendar.appointment.upcoming`.

Steps:
1. Parse with Zod; reject with DLQ on schema failure (never crash the consumer).
2. Resolve tenant; if tenant `status != active` → drop with audit.
3. Determine `use_case` and `purpose` (`transactional` | `service` | `promotional`).
4. Build `idempotency_key` (`shopify:<shop>:order:<id>:cod_confirm` etc.); `INSERT … ON CONFLICT DO NOTHING`; if conflict → audit `duplicate_event` (E-52).
5. Set `event_ts` from the source event (not `now()`), `not_before`, `not_after` per use case:
   - `cod_confirm`: `not_before = event_ts + 2m`, `not_after = event_ts + 30m` (TRAI transactional window) `[VERIFIED]`
   - `abandoned_cart`: `+45m` / `+24h`
   - `appointment_confirm`: `appointment_ts - 24h` / `appointment_ts - 2h`
   - `lead_callback`: `+1m` / `+2h`
6. Sanitise `variables` (E-72): strip control chars, cap each at 120 chars, allow-list keys per use case, never include free-text customer fields in the system prompt (they go into a `{{customer_name}}`-style user-visible slot only).
7. Enqueue Cloud Task for `not_before` (task name = idempotency key hash → dedupe).

### 5.2 Gate (`packages/compliance/gateIntent`) — ordered, first failure wins, all checks recorded

```
1  tenant.active && billing.ok (no frozen subscription; E-50)
2  kill switches: global → engine → tenant → campaign (Redis, 5 s cache)
3  spend caps: tenant daily & monthly; engine daily; global daily (E-32)
4  number validity: E.164, Indian mobile regex, not premium/short/emergency, number-type lookup != landline for +91 (E-26/E-27)
5  suppressions: global(all) | global(purpose) | tenant(all) | tenant(purpose); includes opt_out(90d), complaint, minor_answered, wrong_number(order-scoped) (E-03, E-11)
6  consent: purpose=='transactional' → require now() <= not_after (30-min rule) else GATED('window:transactional_expired') (E-01/E-02);
           purpose in (service, promotional) → require consents row: same tenant, same purpose (or 'all'), captured_at <= 7d for explicit promotional (`[VERIFIED]` 7-day validity), not revoked;
           recipient region US: promotional → consent.source ∈ (checkout_written, form_written); EU: any automated → opt_in required (E-07)
7  window: recipient IANA zone; India 09:00–21:00; US default 08:00–21:00 local `[VERIFY state variants]`; EU 09:00–20:00 `[VERIFY]`; if outside → if transactional: GATED (never reschedule); else reschedule to next window open
8  DND/NCPR: promotional → scrub result must be 'not_registered' (cache 24h); transactional → `[OPEN]` policy flag `dnd.scrub_transactional` (default true until TSP letter says otherwise)
9  attempts: max 2 per 24h, 3 lifetime per (phone_hash, purpose, external_ref); minimum gap since the last
           customer-facing attempt: 2h for service/promotional, 10 min for transactional (so one retry fits
           inside the 30-min COD envelope — see MIN_MINUTES_BETWEEN_ATTEMPTS in packages/compliance); an attempt
           still on the wire always blocks
10 concurrency: tenant live calls < tenant.max_concurrency; engine live < engine.max_concurrency (Redis INCR with TTL; decrement on terminal event; reconcile job repairs leaks)
11 CLI selection: numbers where region matches && purpose ∈ purpose_allowed && status='active' && answer_rate_7d >= 0.25 (E-28); round-robin; none → GATED('cli:none_available')
12 script: approved version exists for (use_case, locale); disclosure validator passed (E-09 truthful AI answer baked in)
```

Gate result is persisted on the intent (`gated_reason`, `gate_trace JSONB`) and surfaced in the dashboard with a plain-language explanation and a "what to do" hint.

### 5.3 Dispatch (`dispatcher`)

- `placeCall` with `maxDurationSec` per use case (COD 120, cart 150, appointment 240, lead 180), `amd` mode per tenant (default `hangup` for promotional, `continue` for COD — E-24), `webhookUrl = https://hooks.naaradh.com/engine/<vendor>/<tenant_hmac>`.
- Write `call_attempts` before calling the engine (status `DISPATCHING`); on engine error → status `FAILED`, decrement concurrency, schedule retry per §5.5.
- If the engine returns an id but the HTTP call times out, **do not retry blindly** (a call may already have started): mark `UNCERTAIN`, poll `fetchCall` by idempotency key; only retry once existence is disproven.

### 5.4 Results (`results-consumer`)

- Normalise vendor events via `adapter.parseWebhook`; verify signature; if vendor is unsigned → `fetchCall` and compare before proceeding (E-23).
- Idempotent on `webhook_events.external_event_id` (E-22).
- On `call.ended`: download recording to GCS within 10 min (E-34), store transcript JSON, run outcome extraction (engine-provided structured result first; fallback LLM extraction on transcript with a fixed schema and temperature 0), set `confidence`.
- Outcome mapping → `call_outcomes`; `billable` computed by `isBillable(outcome, answered_by)`; never billable if `outcome_superseded` (E-40) or duration < 5 s of human speech (E-25).
- Writebacks (each idempotent, retried with backoff, then alert): Shopify tags/note/metafields; optional `orderCancel` only if tenant `auto_cancel_enabled` AND `confidence >= 0.9` (E-44); **no address is ever written** — always `naaradh:address-review` + `needs_review` until Q-19 closes; merchant webhook; CRM activity. The Shopify write-back is scheduled on the outcome row by finalize and executed by the `writebacks` worker **after the transaction commits** (Admin GraphQL, `packages/shopify-sdk`; plan rebuilt from current tenant settings; retryable failures back off 2^n min up to 6 attempts; a revoked token, a disconnected store or a Shopify refusal stops at once — runbook `shopify-writeback.md`).
- Opt-out detected (verbal) → `suppressions` insert (90 d) + merchant notification + update Shopify `smsMarketingConsent` only if `[VERIFY]` policy allows (flag `shopify.sync_optout`, default off).
- Transfer events: record `transferred_to` (masked), `transfer_result`; if `TRANSFER_FAILED` → outcome `callback_requested` (E-30).

### 5.5 Retries

- Retry-eligible terminal reasons: `no_answer`, `busy`, `amd_hangup`, `inconclusive`, `carrier_temp_fail`.
- Not eligible: `wrong_number`, `opt_out`, `recording_refused`, `minor_answered`, `invalid_number`, any billable outcome, `outcome_superseded`.
- Schedule = `min(now + 2h, window_close - 5m)`; if that is after `not_after` → `EXHAUSTED` with reason.
- COD specifics: since `not_after = +30m`, a second attempt usually fits only if the first failed quickly; do not extend the window to "get a retry in."

### 5.6 Cancellation

- Sources: `orders/cancelled`, `orders/updated` (financial/fulfilment status change), merchant cancel via API/dashboard, uninstall, kill switch, campaign stop.
- `SCHEDULED` → status `CANCELLED` (the queue row is the task, ADR-0005).
- `DIALING/RINGING/IN_CONVERSATION` → `adapter.cancelCall` if supported; else let finish and mark outcome `outcome_superseded`, non-billable (E-40). Never bill a call for an order that was cancelled before answer.

### 5.7 Inbound admission (`apps/voice` → `packages/compliance/admitInbound`)

A customer dials a merchant's number. The engine asks `POST /inbound/:vendor` who should answer — one URL per vendor, configured on every inbound number; there is no tenant in it, because the tenant comes only from the called number (invariant 16). In order, first failure wins, every step recorded in the attempt's `admission_trace`:

```
1  number      called E.164 → resolve_inbound_number() → active number, inbound_enabled, profile enabled   (invariant 16)
2  tenant      tenant.status active|pending_review; billing not frozen past grace
3  kill        inbound:* → inbound:<tenant>   (outbound global kill does NOT stop answering)
4  minutes     tenant inbound minutes this month < profile/plan cap                                        (E-92)
5  concurrency tenant inbound live < profile.max_concurrent; engine live < engine max
6  abuse       same caller hash → same tenant: ≤ profile.max_calls_per_caller_hour                        (E-88)
7  engine      breaker closed for the number's engine
```

- **Admit** → create the `call_attempts` row (`direction='inbound'`, `purpose='service'`, no intent, idempotency key = vendor call id so a retried webhook is the same call — E-89, and a concurrent duplicate loses on the unique index and answers from the winner's attempt), upsert the caller's contact (public-key encrypted; withheld caller → `contact_id` and `phone_hash` null, `caller_withheld = true`, identity `none` — migration 0005's `call_attempts_party_known` check; a caller ID that is not a dialable mobile, e.g. a landline, keeps its hash for the abuse limit and order match but gets no contact), compute identity `caller_id` if the caller hash matches any order in the cache, and return: rendered first utterance (disclosure first, invariant 7), system prompt (guardrails + profile + business hours + transfer availability + a short list of pinned facts), tool definitions with signed URLs, dynamic variables (brand, recognised first name only if `caller_id`), max duration.
- **Refuse** → a fallback the engine can execute: forward to `profile.fallback_forward` (the merchant's own number) if set, else a spoken closed message in the profile locale with the business hours. Never silence, never an error tone (E-92).
- The context endpoint must answer in < 500 ms p95; it does at most two indexed queries and two Redis round trips beyond the upserts. If it cannot decide in 2 s the engine's own timeout plays the fallback configured on the number — configure that on every inbound number.

### 5.8 Caller identity (`packages/pipeline/identity`)

| Level | Established by | Grants |
|---|---|---|
| `none` | withheld / unmatched caller ID | knowledge search, create ticket/callback, opt-out |
| `caller_id` | caller's phone hash equals an order's `phone_hash` | read that phone's orders; request cancellation of an unshipped COD order among them |
| `knowledge` | `verify_caller(order_ref, pincode)` matches `orders.name` + `pincode_hash` | the same, for that one order, from any number |

- Verification state lives on the attempt (`caller_verified_at`, `caller_verification`, `verified_order_ids`), never in the prompt — the model cannot talk itself into a higher level.
- Three failed `verify_caller` attempts in one call → locked for the rest of the call (E-94); the agent offers a callback ticket.
- Nothing lets any level change an address, issue a refund or reveal a full address; those are tickets (E-44, E-96).

### 5.9 Agent tools (`apps/voice` `POST /tools/:vendor/:tenantTag/:tool`)

Every tool: signature verified → tenant from the URL tag (`voiceToolPath`, a `voice:`-domain HMAC, so a hooks URL can never be replayed at a tool) → attempt resolved from the vendor call id inside that tenant (the echoed attempt id is accepted only while the engine call id is not yet recorded) → attempt still live → **replay** if this `tool_call_id` was already handled (the stored result is returned, never re-executed, never with a transfer action or a token) → tool enabled for this call → Zod-validated args (strict: unknown keys refused) → identity/tenant-setting checks → action → `agent_actions` row (append-only, args PII-scrubbed, secrets stored only as hashes or masked) → a **short structured result** the agent speaks from. Every outcome the agent can act on is HTTP 200 with `ok: false` and a sentence; only authentication failures are HTTP errors. Budget < 700 ms p95. Inbound calls get the profile's enabled tools; outbound agents get the same minus `confirm_order`, and only when the tenant has an active support profile (its settings — transfer target, cancel toggle — apply).

| Tool | Args | Rule |
|---|---|---|
| `lookup_orders` | `{ order_ref? }` | `caller_id` → that phone's recent orders (≤ 3); `knowledge` → the verified order; `none` → `{ need_verification: true }` |
| `verify_caller` | `{ order_ref, pincode }` | constant-time compare of hashes; 3 strikes lock (E-94); never says *which* factor was wrong |
| `search_knowledge` | `{ query }` | tenant's published articles, full-text, top 3, each ≤ 600 chars; empty → `{ found: false }` and the agent says it will check |
| `confirm_order` | `{ order_ref }` | inbound only; identity must cover the order; a COD order → its queued confirmation call is cancelled (`confirmed_on_inbound`, E-97) and `order.confirmed_by_caller` is emitted; never billed |
| `request_cancellation` | `{ order_ref, reason?, confirm_token? }` | step 1 → readback + single-use token (5 min TTL); step 2 with the token from THIS call → policy re-evaluated (it may have shipped since) → executes only if the profile's `agent_cancel_enabled`, identity covers the order, COD, unfulfilled, not cancelled — an `order_actions` row the actions worker runs, re-checking every guard; else a ticket (E-84, E-85). Either way a queued COD confirmation call for the order is cancelled (E-97). Tokens are single-use (`agent_actions_token_spent_once`) |
| `request_address_change` | `{ order_ref, new_address_summary }` | always a ticket for the merchant (E-44) |
| `create_ticket` | `{ category, summary, callback_requested, preferred_time?, order_ref? }` | `support_tickets` row + merchant event `ticket.created` (id, category and flags only — the summary stays in the dashboard); summary sanitised (E-72); an order is linked only if identity covers it, otherwise the reference goes into the text marked unverified; at most 3 per call (E-90) |
| `transfer_to_human` | `{ reason }` | a verified, active target of the profile, inside its hours → `{ transfer: true, number }` (staff key); else `{ transfer: false, reason: 'after_hours' | 'no_target' }` and the agent offers a callback (E-30, E-86) |
| `register_opt_out` | `{}` | tenant suppression for outbound, all purposes, 90 days (E-03); inbound answering is unaffected |

The model states only what a tool result or a knowledge article says. The system prompt tells it so; the tools make it true by returning nothing else.

---

## 6. Compliance layer contracts (`packages/compliance`)

- `recordConsent({tenantId, phone, purpose, source, evidenceUri, wordingVersion, capturedAt})` — validates `source` ∈ allowed set per recipient region; computes `expires_at` (promotional explicit: +7 d India `[VERIFIED]`; US written: none; EU opt-in: none unless withdrawn); append-only.
- `revokeConsent(...)`, `suppress({scope: 'global'|'tenant', phone, purpose|'all', reason, untilDays})`.
- `gateIntent(intent, ctx) → { ok: true, cli, script } | { ok: false, reason, retryAt?, trace }`.
- `admitInbound(input, deps) → { ok: true, lease, trace } | { ok: false, reason, fallback, trace }` (§5.7).
- `disclosureValidator(scriptBody, locale)` — asserts first utterance contains the locale's AI + recording disclosure phrase from `packages/scripts/disclosures/<locale>.json`; fails build if a script template lacks it.
- `complaint.record({tenantId, phone, source})` → increments 10-day rolling counters (Redis ZSET + Postgres) → `tenant.status = paused` at 3, global kill at 5 (E-05) → PagerDuty/email alert.
- `dndScrub(phone, region)` — provider-backed; results cached 24 h; failures = "registered" (fail closed) for promotional.
- `windowFor(phone) → {zone, open, close}`; `isOpen(ts, phone)`.
- All functions pure where possible; side-effecting ones take an explicit `tx`.

Everything above has a compliance regression test in `packages/compliance/test/regression/*.test.ts` that must stay green.

---

## 7. Shopify app rules

- Public embedded app; session-token auth; App Bridge; Polaris; GraphQL Admin only `[VERIFIED requirements]`.
- Scopes (minimum): `read_orders, write_orders, read_customers, write_customers, read_checkouts, read_fulfillments, read_locales`. Adding a scope requires: ADR + `docs/shopify/pcd-justification.md` update + re-review awareness.
- **Protected customer data Level 2** required (phone + name) `[VERIFIED]`; the app must handle `null` phone/name when not yet approved (gate `no_phone`).
- Webhooks (all HMAC-verified, deduped by `X-Shopify-Webhook-Id`, ack < 5 s): `orders/create, orders/updated, orders/cancelled, orders/fulfilled, fulfillments/update, checkouts/create, checkouts/update, customers/update, app/uninstalled, app_subscriptions/update, shop/update` + mandatory `customers/data_request, customers/redact, shop/redact` (return 401 on bad HMAC; complete within 30 days; `shop/redact` arrives 48 h post-uninstall) `[VERIFIED]`.
- Billing: `appSubscriptionCreate` with recurring + usage lines; `cappedAmount` = tenant spend cap; usage via `appUsageRecordCreate` keyed by `outcome_id` (idempotent); on capped → pause + notify (E-61).
- Order writebacks: tags `naaradh:*`, note append, metafields namespace `naaradh` (`cod_status, last_call_at, attempts, confidence, outcome_ref`).
- COD detection: normalise `paymentGatewayNames` against `packages/shopify-sdk/gateways.ts` (Shopify manual/COD + GoKwik/Shiprocket/Magic/Cashfree variants) (E-45). Unknown gateway → not COD → no call + telemetry.
- Abandoned checkout: only when the shop uses Shopify Checkout; else ingest provider webhooks (E-14). Promotional consent must come from the custom checkout-extension checkbox (`naaradh_call_consent` order attribute) + ledger; `smsMarketingConsent` alone is insufficient (E-13) `[LEGAL wording]`.
- Uninstall: stop dispatch ≤ 60 s (delete tasks, set tenant `paused`), purge on `shop/redact`, retain consents/suppressions/billing/audit (E-48).
- Reconcile: hourly GraphQL `orders(query: "created_at:>… gateway:…")`; create intents only if inside window; else report (E-53).
- Dev: `shopify app dev` against a dev store with COD manual gateway; staging Partner app separate from prod.

---

## 8. Public API and merchant webhooks (`apps/api`)

- Auth: `Authorization: Bearer nrd_live_…` (hashed at rest, scoped, per-key daily caps, optional IP allow-list) — E-70.
- Endpoints: `POST /v1/intents`, `GET /v1/intents/:id`, `POST /v1/intents/:id/cancel`, `POST /v1/consents`, `POST /v1/suppressions`, `GET /v1/calls/:id/recording` (signed URL 15 min), `POST/GET/DELETE /v1/webhooks`.
- `Idempotency-Key` header honoured for 24 h; replay returns the original response.
- Rate limit 60 rpm (burst 120) per key; `429` + `Retry-After`.
- Outbound merchant webhooks: events `intent.scheduled, intent.gated, call.started, call.completed, outcome.final, suppression.created`; headers `X-Naaradh-Signature: t=<unix>,v1=<hmac_sha256(t + '.' + body)>`; 5-min replay window; retries 5×(exponential) then dead-letter visible in dashboard.
- Public site key (`nrd_pk_…`) for the JS snippet: `intents:create` only, domain allow-list, 10 rpm per IP.
- OpenAPI 3.1 generated from Zod (`pnpm openapi`), published to `docs.naaradh.com`.

---

## 9. Agent scripts (`packages/scripts`)

- Templates are JSON: `{use_case, locale, version, opening, purpose_line, branches[], closing, extraction_schema, max_duration_sec, forbidden_topics[]}`.
- Mandatory opening: greeting + brand + AI disclosure + recording disclosure (per-locale phrase file). Build fails if missing.
- Variables: only allow-listed keys per use case; rendered with strict escaping; free text capped (E-72).
- Guardrails baked into system prompt: never request/read OTP, card, UPI PIN, Aadhaar, passwords; never invent discounts/dates/refunds; answer "are you human?" truthfully (E-09); on opt-out phrases end call immediately; wrong person → one handover attempt (10 s) then end; silence → 2 prompts then end; minor detected → end (E-11); recording refusal → end or stop recording if supported (E-12).
- Extraction schemas are Zod; results validated; invalid → `inconclusive` + alert (never guess an outcome).
- Every attempt stores `script_version`; scripts immutable per version; merchant approval recorded (`approved_by_user_id`, `approved_at`).
- A/B: tenant-level, 50/50, metrics: answer rate, confirm rate, opt-out rate, complaint rate, cost/outcome.
- **Inbound agent profiles** (`inbound_profiles`) are not branch scripts — an inbound caller can ask anything. A profile is: brand, locale(s), greeting (must pass the same disclosure validator), persona line, business hours, which tools are enabled, pinned facts (≤ 20 short lines), fallback forward number, transfer target. `renderInboundPrompt(profile, context)` produces the system prompt: global guardrails + inbound rules (identity before information, tools are the only source of order facts, no promises outside articles/tool results, offer a ticket rather than guess) + the tool list + pinned facts. Profiles are versioned like scripts; the attempt stores the profile version it ran.
- Inbound extraction schema `inbound_support_v1`: `{ outcome: resolved|ticket_created|transferred|callback_requested|abandoned|opt_out|spam|inconclusive, category, summary, confidence }`.

---

## 10. Engine adapter contract and testing

- Implement `VoiceEngineAdapter` exactly as in `packages/engines/core`. Capabilities: `{inbound, cancel, warmTransfer, midCallTools, perSecondBilling, recordingToggle, signedWebhooks, reportsDisclosure}`; product code branches on capabilities, never on vendor name.
- **Inbound surface** (required for ADR-0006): `parseInboundRequest(headers, rawBody) → InboundCallRequest` (verified; called number, caller number or null, vendor call id), `formatInboundResponse(decision) → { status, headers, body }` (answer with prompt/tools/variables, or forward/closed-message fallback, in the vendor's format), `parseToolCall(headers, rawBody) → ToolCallRequest` (verified; vendor call id, tool name, args), `formatToolResult(result)`. The adapter translates; it never decides.
- Each adapter ships: `client.ts` (HTTP), `map-events.ts`, `map-errors.ts`, `map-inbound.ts`, `fixtures/*.json` (sanitised recorded payloads), `contract.test.ts` (runs the shared harness in `packages/engines/harness`).
- Harness scenarios: answered-human-confirmed, answered-machine, no-answer, busy, transfer-success, transfer-fail, opt-out mid-call, webhook-duplicate, webhook-out-of-order, webhook-missing (poll path), unsigned-webhook (re-fetch path), 429 backoff, 5xx circuit-open; **inbound:** context request parses and a bad signature is rejected, answer/forward/closed responses round-trip, tool call parses and a bad signature is rejected, tool result round-trips.
- Cost: adapters must return `billable_sec` and vendor `cost` from CDR when available; `billing-meter` records margin per call and alerts if GM < 40% (E-33).
- Never log vendor request/response bodies at `info`; `debug` only with PII redaction.

---

## 11. Security rules for agents

- No secrets in code, tests, fixtures, docs, or commit messages. `gitleaks` runs in CI.
- No raw phone numbers anywhere in git; use `packages/shared/test/fake-phones.ts` (reserved ranges) and clearly fake names.
- Every new inbound endpoint: signature verification + schema validation + rate limit + dedupe, or it does not merge.
- Every new table: RLS policy; every new column that may hold PII: added to logger redaction and to the erasure job.
- Every new outbound integration: secret via Secret Manager, egress via Cloud NAT static IP, timeout + retry + circuit breaker.
- Dependencies: pin exact versions; review licences; no packages that phone home.
- Prompt-injection surface: any string from merchants/customers is data, never instruction; sanitise and slot.
- Access to recordings and transcripts is role-gated (operator+) and audited before it is served; merchants see it in their access log. Staff reach evidence only through the IAP console, audited as `staff:<email>`. ("Reveal number": deferred, ADR-0009.)

---

## 12. Testing and CI gates

CI on every PR: `lint`, `lint:pii`, `typecheck`, `test` (unit), `test:int` (Testcontainers), `test:compliance` (regression), `test:contracts` (engine adapters), `gitleaks`, `trivy` (containers), `terraform validate/plan` (read-only), Shopify GraphQL codegen check (no drift), OpenAPI drift check.

Required new tests by area:
- Compliance: one positive + one negative per gate touched; boundary tests at 08:59/09:00/20:59/21:00 IST and at `event_ts + 29m59s` / `+30m01s`.
- Dispatcher: idempotency under duplicate tasks; uncertain-dispatch path; concurrency leak repair.
- Results: duplicate/out-of-order webhooks; unsigned re-fetch; superseded outcome; billable computation.
- Shopify: HMAC pass/fail (401), compliance webhooks, gateway normalisation table, uninstall stop ≤ 60 s.
- Billing: usage record idempotency; capped-amount pause; dispute credit path; inbound minute metering (round-up per call, never double-metered on a duplicate ended event).
- Inbound: one positive + one negative per admission step; every tool with an unverified caller (must be refused), a verified caller, and another customer's order (must be refused); cancellation two-step (no token → readback only; wrong/expired/reused token → refused; shipped/prepaid → ticket); transfer after hours; withheld caller; abuse limit; latency budget asserted in the integration test.

Load/chaos (staging, weekly): 500 webhooks/60 s; 50 concurrent simulated calls; **100 inbound context requests/10 s with tool calls at p95 < 700 ms**; engine simulator failures; DB failover.

---

## 13. Operations and runbooks (`docs/runbooks/`)

Agents should keep these current when changing behaviour:
- `engine-outage.md` — circuit breaker, failover flag, comms.
- `complaint-received.md` — intake, attribution, tenant pause, TRAI response `[LEGAL]`.
- `kill-switch.md` — how to flip global/engine/tenant/campaign; audit expectations.
- `stuck-attempts.md` — poller, manual reconcile, concurrency repair.
- `erasure-request.md` — DPDP/Shopify redact flow and verification.
- `billing-dispute.md` — evidence bundle (recording, transcript, outcome, timestamps), credit note.
- `cli-health.md` — answer-rate monitoring, rotation, retirement.
- `shopify-api-upgrade.md` — quarterly version bump checklist.
- `restore-drill.md` — quarterly Neon point-in-time restore test (`scripts/restore-drill.sh`).
- `secret-rotation.md` — rotation class per secret; the re-encryption jobs.
- `on-call.md` — rota, severities, first 15 minutes, escalation.
- `load-test.md` — k6 scripts, thresholds, the chaos test.

SLOs (SPEC §6.8): webhook ack p99 < 800 ms; intent→dial p95 < 90 s in window; results p95 < 60 s; dashboard 99.9%.

---

## 14. Edge-case catalogue (implementation notes) — full definitions in SPEC §12

| ID | Where implemented | Test name |
|---|---|---|
| E-01 order at 20:50 | gate step 7 + dispatcher urgency | `gate.dials_before_close_or_gates` |
| E-02 order after window | gate step 6/7 | `gate.transactional_expired_never_reschedules` |
| E-03 prior opt-out | gate step 5 | `gate.suppression_blocks_new_order` |
| E-04 DND transactional `[OPEN]` | gate step 8 flag | `gate.dnd_policy_flag` |
| E-05 complaint thresholds | `complaints` worker | `complaints.pause_at_3_kill_at_5` |
| E-06 PE de-link | tenant compliance status | `gate.pe_delinked_blocks_promotional` |
| E-07 cross-region recipient | gate steps 6/7/11 | `gate.recipient_region_wins` |
| E-08 asserted consent w/o evidence | consents API validation | `consent.requires_evidence_or_attestation` |
| E-09 "are you human?" | script guardrail | `script.truthful_ai_answer` |
| E-10 erasure during call | results → erasure_requests | `erasure.from_call_flag` |
| E-11 minor answers | results → suppression | `results.minor_answered_suppresses` |
| E-12 recording refused | results/engine capability | `results.recording_refused_ends` |
| E-13 no voice-consent object | Shopify checkout extension + ledger | `shopify.promotional_requires_custom_consent` |
| E-14 one-click checkout providers | intents-consumer sources | `intents.provider_abandoned_cart` |
| E-20 engine down | adapter circuit breaker | `engine.circuit_open_holds_intents` |
| E-21 missing webhook | reconcile poller | `reconcile.polls_stuck_attempts` |
| E-22 duplicate webhook | results dedupe | `results.duplicate_event_ignored` |
| E-23 unsigned webhook | results re-fetch | `results.unsigned_requires_fetch` |
| E-24 AMD false positive | tenant amd mode; metric | `dispatch.amd_mode_per_purpose` |
| E-25 pocket answer | billable rule | `billing.min_human_speech` |
| E-26/27 invalid/landline | gate step 4 | `gate.invalid_number` |
| E-28 spam-flagged CLI | gate step 11 + cli-health | `cli.retire_low_answer_rate` |
| E-29 concurrency | gate step 10 priority queue | `dispatch.priority_queue_no_drop` |
| E-30 transfer fails | results | `results.transfer_failed_callback` |
| E-31 language switch | script/engine capability | `script.locale_switch_logged` |
| E-32 cost spike | gate step 3 + maxDuration | `gate.spend_caps` |
| E-33 vendor price change | billing-meter margin alert | `billing.margin_alert` |
| E-34 recording URL expiry | results download | `results.recording_persisted_10m` |
| E-40 cancel while ringing | cancellation | `cancel.superseded_non_billable` |
| E-41 confirm then cancel | writeback tag | `writeback.cancelled_after_confirm_tag` |
| E-42 multi-order same phone | intents merge | `intents.merge_same_phone_30m` |
| E-43 no phone | gate `no_phone` | `gate.no_phone` |
| E-44 low-confidence address | writeback rule | `writeback.address_requires_confidence` |
| E-45 gateway mismatch | gateway normalisation | `shopify.gateway_table` |
| E-46 test/staff orders | intents skip rules | `intents.skip_test_orders` |
| E-47 value thresholds | tenant use-case config | `intents.value_thresholds` |
| E-48 uninstall | shopify uninstall flow | `shopify.uninstall_stops_in_60s` |
| E-49 API deprecation | codegen drift CI | `ci.graphql_drift` |
| E-50 billing frozen | gate step 1 | `gate.billing_frozen_pauses` |
| E-51 timezone | windowFor | `window.recipient_zone` |
| E-52 duplicate orders/create | idempotency | `intents.duplicate_webhook` |
| E-53 missed webhook | reconcile | `reconcile.creates_only_in_window` |
| E-60 billable definition | `isBillable` | `billing.billable_enum_fixed` |
| E-61 capped amount | billing-meter | `billing.capped_pauses` |
| E-62 dispute | disputes API | `billing.dispute_credit` |
| E-63 FX | billing-meter | `billing.fx_recorded` |
| E-70 stolen key | api anomaly + caps | `api.key_anomaly_revoke` |
| E-71 bought list | consent gate + AUP flag | `gate.no_consent_promotional` |
| E-72 prompt injection | variable sanitiser | `scripts.sanitise_variables` |
| E-73 impersonation | tenant verification | `tenant.new_tenant_review_window` |
| E-74 insider access | audit + roles | media access audited before serving; access log (`packages/pipeline/test/int/dashboard.test.ts`, console `transcript.accessed`) |
| E-80 withheld caller ID | admission + identity `none` | `inbound.withheld_caller_is_unverified` |
| E-81 unknown number called | admission step 1 | `inbound.unrouted_number_closed_message` |
| E-82 other customer's order | tools identity check | `tools.lookup_refuses_foreign_order` |
| E-83 caller ID spoofing | identity levels | `tools.caller_id_never_unlocks_address` |
| E-84 cancel by voice | two-step token | `tools.cancel_requires_second_confirmation` |
| E-85 cancel shipped/prepaid | cancellation rules | `tools.cancel_shipped_becomes_ticket` |
| E-86 caller-supplied transfer number | transfer tool | `tools.transfer_only_verified_target` |
| E-87 transfer after hours | transfer tool | `tools.transfer_after_hours_offers_callback` |
| E-88 caller floods the line | admission step 6 | `inbound.abuse_limit` |
| E-89 duplicate context webhook | idempotent attempt on vendor call id | `inbound.context_idempotent` |
| E-90 spoken prompt injection | tools enforce limits | `tools.injection_cannot_escalate` |
| E-91 knowledge gap | search returns nothing → ticket | `tools.no_article_no_answer` |
| E-92 cap / pause / kill | admission fallback | `inbound.fallback_never_dead_air` |
| E-93 tool timeout | engine plays holding line; result late | `voice.tool_latency_budget` |
| E-94 verification brute force | 3-strike lock per call | `tools.verify_locks_after_three` |
| E-95 opt-out on inbound | outbound suppression | `tools.opt_out_suppresses_outbound` |
| E-96 refund / address request | ticket only | `tools.money_and_address_are_tickets` |
| E-97 inbound during outbound retry | same phone, outbound intent live | `inbound.caller_with_live_intent_cancels_redial` |

---

## 15. Open questions that block code (`docs/open-questions.md` is canonical)

1. CLI series for non-BFSI service calls — TSP letters pending. Until resolved: `numbers.purpose_allowed` is human-set; no default.
2. DND scrub on transactional — flag default `true`.
3. DCA requirement for voice consent — not implemented; ledger stores `source='dca'` placeholder.
4. Per-second billing at chosen vendor — `capabilities.perSecondBilling` must be verified from invoice, not docs.
5. Telemarketer-of-record with vendor numbers — affects complaint attribution logic.
6. Shopify policy on app-driven `smsMarketingConsent` updates from verbal opt-out — flag `shopify.sync_optout=false`.
7. Shopify checkout-extension consent wording for calls — `[LEGAL]`.
8. One-click checkout providers' webhook access — partner programs.
9. DPDP final rules timelines — retention/erasure constants in `packages/compliance/constants.ts` are placeholders marked `TODO_LEGAL`.

If a task depends on any of these, implement behind a flag with the conservative default and note the dependency in the PR.

---

## 16. Definition of done (all work)

- Tests as required in §12; CI green.
- No new `any`, no raw PII in logs/fixtures, RLS on new tables, redaction updated.
- Audit log + merchant webhook for new terminal states.
- Docs: ADR if a decision changed; runbook if operators must act; SPEC edge-case list if a new `E-xx` was discovered.
- PR template filled: change summary, invariants touched, `E-xx` covered, `[OPEN]/[LEGAL]` dependencies, rollback plan.

---

*Not legal advice. Regulatory constants and vendor facts drift; verify `[VERIFY]` items at implementation time and record the source in the PR.*
