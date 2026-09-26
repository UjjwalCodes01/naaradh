# PLAN.md — Naaradh phased delivery plan

**Companion documents:** `docs/NAARADH_BUILD_SPEC.md` (SPEC — product/regulatory), `AGENTS.md` (engineering rules), `CLAUDE.md` (Claude Code entry point).
**Plan owner:** Founder. **Assumed team:** founder + 1–2 engineers (or founder + AI coding agents). **Start:** Week 0 = week of 15 September 2026.

**Direction (12 Sep 2026, ADR-0006):** Naaradh is a two-way AI voice agent; **inbound support is the lead product**. Phase 1B (inbound) is inserted directly after the core pipeline and ahead of the public Shopify app; later phases shift by three weeks. Ticket IDs of existing phases are unchanged so references in code and docs stay valid.

**Sequencing note (founder decision, 11 Sep 2026):** build first, paperwork after. Entity, GST, DLT and TSP letters are moved out of the critical path of the build, with the known consequence that **no call to a real customer** (inbound on a real number, or outbound) happens until the entity and an eKYC'd number exist (SPEC §3.2). Everything before that runs on the simulator.

Each phase has: goal → entry criteria → workstreams with tickets → exit criteria → kill/pivot criteria → metrics → risks. Ticket IDs are `P<phase>-<area>-<n>`. Areas: `LEG` legal/regulatory, `INF` infra, `CORE` pipeline, `INB` inbound agent, `SHOP` Shopify, `API` public API, `CMP` compliance, `WEB` dashboard/site, `BILL` billing, `OPS` operations, `GTM` go-to-market, `ENG` engine.

Tags: `[OPEN]` blocked on an unresolved external answer · `[LEGAL]` needs lawyer/CA · `[VERIFY]` confirm at execution.

---

## Phase overview

| Phase | Name | Weeks | Outcome |
|---|---|---|---|
| 0 | Validate & bootstrap | 0–2 | Engine chosen **on inbound + tool latency as well as outbound**, RTO baseline known, repo skeleton; paperwork deferred (see note) |
| 1 | Core pipeline | 2–4 | **Done on the simulator (Sep 2026):** schema + RLS, gate, dispatcher, results, reconcile, hooks, API, merchant webhooks. Live calls wait for a real engine + number |
| **1B** | **Inbound support line** | **4–7** | **A merchant's number answered by the agent: admission, identity, order lookups, knowledge base, two-step cancellation, tickets, transfer, minutes billing — Client A's support line live in pilot** |
| 2 | Shopify app + compliance layer + dashboard | 7–10 | Installable Shopify app with billing, consent ledger, suppressions, DNC page, dashboard with calls, tickets, knowledge editor, recordings, RTO analytics |
| 3 | Harden, legal, App Store submission | 10–12 | Security checklist done, legal docs live, Level 2 PCD approved or pending, App Store review submitted |
| 4 | First 10 merchants + promotional use cases | 12–16 | Paying merchants beyond the first two, abandoned cart with consent capture, case study published |
| 5 | Integrations expansion | 16–23 | WooCommerce plugin, Zoho/HubSpot, Cal.com appointments (inbound booking too), one-click-checkout providers, Zapier |
| 6 | US/EU launch | 23–31 | Separate GCP projects, Retell adapter, TCPA/ePrivacy flows, DPA/DPIA, USD pricing |
| 7 | Scale & optionality | 31+ | Self-hosted engine evaluation, enterprise features (multiple lines, IVR menus, SSO), Delaware entity if raising |

Timeline is aggressive but realistic for a small team using the pre-decided stack; Shopify review and DLT registration are the two external clocks you cannot compress.

---

## Phase 0 — Validate & bootstrap (Weeks 0–2)

**Goal:** Answer the three questions that can kill the business before writing product code, and stand up the minimum infrastructure and paperwork with long lead times.

**Entry criteria:** Domain `naaradh.com` purchased (done). Two clients willing to pilot (done).

Step-by-step instructions for every external item below (accounts, registrations, numbers, keys) are in [`docs/go-live/`](docs/go-live/README.md).

### Workstreams

**LEG — Legal & regulatory**
- P0-LEG-1 Engage CA; file Pvt Ltd (SPICe+), obtain PAN/TAN; open current account. `[LEGAL]`
- P0-LEG-2 GST registration as soon as CoI arrives. `[LEGAL]`
- P0-LEG-3 Send TSP/CPaaS email (SPEC Appendix A) to Exotel, Plivo, and Airtel/Jio enterprise. Track replies in `docs/legal/tsp-responses/`. `[OPEN]`
- P0-LEG-4 Engage a TMT/telecom + data lawyer for a scoped opinion: non-BFSI service-call CLI, telemarketer liability, DPDP processor duties, consent wording for checkout. `[LEGAL]`
- P0-LEG-5 Trademark search + filing for "Naaradh" (Classes 9, 35, 38, 42).
- P0-LEG-6 Create Shopify Partner account; read Partner Program Agreement and App Store requirements; note revenue share and billing rules.
- P0-LEG-7 Start `docs/open-questions.md` with SPEC §18 items and owners.

**ENG — Engine bake-off**
- P0-ENG-1 Sign up: Bolna, OmniDimension (direct API), Retell (for reference). Fund minimal wallets.
- P0-ENG-1B **Inbound bake-off** (ADR-0006): on each engine, attach a number, point its inbound-context webhook and tools at a staging `voice`, and run 15 inbound scenarios — order status by caller ID, verification by order number + pincode, "cancel my order" two-step, FAQ with and without a matching article, "talk to a person" in and out of hours, withheld caller ID, Hinglish switch mid-sentence, caller interrupting while a tool runs. Measure tool round-trip p50/p95 **as heard on the handset**, filler behaviour, and whether the engine lets us set tool timeouts and return a transfer number. An engine that cannot do mid-call tools under ~1 s is disqualified for inbound.
- P0-ENG-2 Write the COD confirmation script v0 (Hinglish + English) with mandatory disclosure opening (SPEC §10.2).
- P0-ENG-3 Run the 20-scenario bake-off (SPEC §15.1) on Jio/Airtel/Vi handsets; record every call; fill Appendix B sheet.
- P0-ENG-4 Verify **per-second billing and minimum billable duration from the vendor invoice/CDR**, not docs. `[OPEN]`
- P0-ENG-5 Ask each vendor the 15 questions in SPEC §5.4 in writing; store answers.
- P0-ENG-6 Decision: primary India engine + secondary; write `docs/decisions/ADR-0001-india-engine.md`.

**GTM — Baseline**
- P0-GTM-1 Pull Client A 90-day order data (SPEC Appendix C); compute COD share, RTO %, RTO cost, monthly RTO loss ₹.
- P0-GTM-2 Interview 5 D2C brands (100+ COD orders/day): RTO %, confirmation method, cost per confirmation, willingness to pay per confirmed order.
- P0-GTM-3 Define outcome pricing v0 (SPEC §2.2) and put both clients on it in writing.

**INF — Infrastructure bootstrap**
- P0-INF-1 GCP Organization + Cloud Identity; projects `naaradh-shared`, `naaradh-dev`, `naaradh-stage-in`, `naaradh-prod-in`; billing account with budgets/alerts; org policies (resource locations = `asia-south1/asia-south2`).
- P0-INF-2 Move `naaradh.com` nameservers to Cloud DNS; create zone; DNSSEC; registrar lock + 2FA; CAA records.
- P0-INF-3 Google Workspace on `naaradh.com`; SPF/DKIM/DMARC; mailboxes `support@ legal@ privacy@ dnc@ security@`.
- P0-INF-4 Terraform skeleton in `infra/`: state bucket, VPC, Cloud NAT, Secret Manager, KMS keyring, Artifact Registry, Workload Identity Federation for GitHub.
- P0-INF-5 GitHub org `naaradh`, repo with `CLAUDE.md`, `AGENTS.md`, `PLAN.md`, `docs/`, PR template, branch protection, gitleaks + CI skeleton.
- P0-INF-6 Monorepo scaffold: pnpm + Turborepo, one folder per service and per shared library at the repo root (empty but wired), `docker-compose.yml` (Postgres 16, Redis 7, Pub/Sub emulator).

### Exit criteria
- ADR-0001 written with bake-off data attached; extraction accuracy ≥ 85% on real numbers; per-second billing confirmed from invoice.
- Client A monthly RTO loss quantified; both clients agreed to outcome pricing.
- TSP emails sent (replies may still be pending); lawyer engaged; incorporation filed.
- `pnpm dev` runs an empty stack locally; Terraform plans cleanly for dev.

### Kill / pivot criteria
- Extraction accuracy < 85% on all engines, or no engine offers per-second billing, or Client A's RTO loss < ₹1 lakh/month and interviews show no pain → **pause and re-choose vertical** (appointment confirmation for clinics is the fallback wedge).
- Any TSP reply saying non-BFSI service calls cannot be placed on a compliant CLI at all → escalate to lawyer before Phase 1.

### Metrics
Bake-off accuracy, first-response latency p50, cost per 45-s call, answer rate on real numbers, Client A RTO % baseline.

---

## Phase 1 — Core pipeline + first live calls (Weeks 2–4)

**Goal:** A minimal, compliant, idempotent pipeline that places real calls for the two existing clients — Client B via REST API (lead callback), Client A via a Shopify webhook mirror (COD confirmation) — with results visible in a bare admin view.

**Entry criteria:** Phase 0 exit; engine API key for the winner; at least one +91 number provisioned with `purpose_allowed` set by a human (`[OPEN]` CLI series).

### Workstreams

**CORE — Data + pipeline**
- P1-CORE-1 `db`: schema from SPEC §6.5 (all tables), RLS policies, drizzle migrations, seed with fake tenants and fake numbers.
- P1-CORE-2 `shared`: ids (ULID prefixes), errors, `pino` logger with redaction, phone hash/encrypt utils, E.164 validation, money/time utils, fake-phone ranges.
- P1-CORE-3 `hooks`: Fastify service; generic verified-webhook pipeline → `webhook_events` (dedupe) → Pub/Sub publish → 200 in < 800 ms; Shopify HMAC verifier; engine signature verifiers; DLQ topics.
- P1-CORE-4 `workers/intents-consumer`: source parsers (Shopify `orders/create`, API intents), idempotency keys, `event_ts`/`not_before`/`not_after` per use case, variable sanitiser (E-72), Cloud Tasks enqueue.
- P1-CORE-5 `compliance` v0: `gateIntent` with steps 1–12 (SPEC AGENTS §5.2) — suppressions, consent lookup, windows (luxon, IST), attempts, concurrency (Redis), CLI selection, kill switches, spend caps; `gate_trace` persisted.
- P1-CORE-6 `workers/dispatcher`: gate → `placeCall` → `call_attempts`; uncertain-dispatch handling; retry scheduling (AGENTS §5.5); cancellation (§5.6).
- P1-CORE-7 `workers/results-consumer`: normalise events, idempotency, recording download to GCS (CMEK bucket), transcript store, outcome extraction with Zod schema, `isBillable`, audit log, merchant webhook emit.
- P1-CORE-8 `workers/reconcile`: stuck-attempt poller (E-21); concurrency leak repair.
- P1-CORE-9 Compliance regression suite v0 with boundary tests (08:59/09:00/20:59/21:00 IST; +29m59s/+30m01s).

**ENG — Adapters**
- P1-ENG-1 `engines`: `VoiceEngineAdapter` interface + `capabilities()`; contract-test harness with 13 scenarios (AGENTS §10).
- P1-ENG-2 `engines/simulator` (deterministic scripted events, used in all CI).
- ◐ P1-ENG-3 Adapter for the Phase 0 winner (Bolna or OmniDim) with sanitised recorded fixtures. *Code done (20 Sep 2026), ahead of the bake-off so it can run through Naaradh:* `engines/bolna` and `engines/omnidim`, from the vendors' published APIs, passing the shared contract on stand-in fixtures. Both vendors send **unsigned** webhooks, so outcomes are written from the record fetched back from the vendor (`EngineCallSnapshot.result`, E-23). Recorded fixtures and every `[VERIFY]` wait on accounts (go-live 03 §5).
- P1-ENG-4 Agent creation/versioning through the adapter; script v1 for `cod_confirm` and `lead_callback` in `call-scripts` with disclosure validator.

**API — Client B**
- P1-API-1 `api`: API keys (hashed, scoped), `POST /v1/intents`, `GET /v1/intents/:id`, `POST /v1/intents/:id/cancel`, `POST /v1/consents`, `POST /v1/suppressions`, rate limits, `Idempotency-Key`.
- P1-API-2 Outbound merchant webhooks with HMAC signature and retries.
- ✅ P1-API-3 Minimal `naaradh.js` snippet with consent checkbox helper; public site key. Built in Phase 2: `web/public/naaradh.js` (served by the web app until cdn.naaradh.com exists) + CORS for public keys on `POST /v1/intents`.
- P1-API-4 Client B wired: form submission → lead-callback intent → call → result webhook to their site.

**SHOP — Client A mirror (not the public app yet)**
- P1-SHOP-1 Custom app on Client A's store (private/custom distribution) subscribing `orders/create`, `orders/cancelled`, `orders/updated`; HMAC verified; gateway normalisation table v0 (Shopify manual/COD + GoKwik/Shiprocket/Magic/Cashfree names) (E-45).
- ✅ P1-SHOP-2 Writebacks: tags `naaradh:*`, order note, metafields — Admin GraphQL client in `shopify-sdk`, executed by the `writebacks` worker outside the results transaction, retried with backoff. No address write (Q-19). `orderCancel` is used only by the gated paths: extraction auto-cancel (setting on + confidence ≥ 0.9) and the agent's two-step cancellation (ADR-0006). Live verification against a dev store is the last step before `SHOPIFY_WRITEBACK=live`.
- P1-SHOP-3 Client A live in **pilot mode**: 10% of COD orders for 2 days → 50% → 100%; daily review of recordings.

**INF**
- P1-INF-1 Terraform: Cloud SQL (private IP, HA off in stage, on in prod), Memorystore, Pub/Sub topics/subscriptions with DLQs, Cloud Tasks queues, GCS recordings bucket (CMEK, lifecycle), Cloud Run services with min instances, LB + Certificate Manager + Cloud Armor baseline, Cloud NAT static IP.
- P1-INF-2 CI: lint, typecheck, unit, integration (Testcontainers), compliance, contracts, gitleaks, trivy; deploy to stage on `develop`.
- P1-INF-3 Structured logging + Error Reporting + basic alerts (engine error rate, DLQ depth, no-events-in-window).

**OPS**
- P1-OPS-1 Runbooks v0: `kill-switch.md`, `engine-outage.md`, `stuck-attempts.md`.
- P1-OPS-2 Internal admin page (bare) listing intents/attempts/outcomes with gate reasons and recording playback (signed URLs).

### Exit criteria
- Client A: ≥ 200 real COD confirmation calls placed inside the 30-minute window; zero calls outside 09:00–21:00 IST (proven by query); outcome extraction validated by human review ≥ 90% agreement.
- Client B: lead-callback live; merchant webhook delivered and verified.
- Every attempt has `ai_disclosed_at` and `recording_disclosed_at`; recordings in GCS; no raw phone in logs (`lint:pii` + log sample audit).
- Compliance regression suite green in CI; contract tests green for simulator + chosen engine.

### Kill / pivot criteria
- Answer rate on real numbers < 35% after CLI rotation → investigate carrier flagging / CLI series before scaling.
- Human-review disagreement with extraction > 15% → script/extraction rework before Phase 2.

### Metrics
Answer rate, confirm rate, cancel rate, no-answer rate, avg billable seconds, cost per call, cost per billable outcome, intent→dial p95, gated-reason distribution.

---

## Phase 1B — Inbound support line (Weeks 4–7)

**Goal:** A merchant's customers call a number and an AI answers, resolves what it can from real data, acts only within what the merchant allowed, hands off cleanly, and every call is recorded, audited and billed by the minute (ADR-0006).

**Entry criteria:** Phase 1 core on the simulator (done). For live calls: an engine that passed P0-ENG-1B, an inbound-capable number, entity/eKYC (see sequencing note).

**Status (12 Sep 2026):** everything that does not need a real engine or a real number is **done on the simulator** — INB-1…6, CORE-1…3, API-1, OPS-1, and the simulator half of the exit criteria (`voice/test/int/voice.test.ts`, 25 tests through voice + hooks + results on Postgres + Redis). Open: P1B-ENG-1 (blocked on the P0 bake-off, ADR-0001), P1B-OPS-2 (needs Cloud Monitoring, P0-INF-4), the live exit criteria, and a live smoke test of the Shopify write-back (P1-SHOP-2, built — see Phase 1) against a real dev store. Beyond the plan: `confirm_order` (the "confirm" half of E-97), a tool-call replay guard (`agent_actions.tool_call_id`), migration 0005 (withheld callers have no contact), Devanagari-aware knowledge search, and the inbound contract suite every vendor adapter must pass.

### Workstreams

**INB — Agent runtime (`voice`)**
- ✅ P1B-INB-1 Schema: `inbound_profiles`, `knowledge_articles` (FTS), `orders` cache, `support_tickets`, `agent_actions` (append-only), inbound columns on `call_attempts`, outcome/kill-switch enum values, staff key pair for transfer targets; RLS + grants + triggers; `resolve_inbound_number()`.
- ✅ P1B-INB-2 `admitInbound()` in `compliance` (AGENTS §5.7) + regression suite: one positive and one negative per step; fallback behaviour (forward / closed message).
- ✅ P1B-INB-3 Engine contract for inbound: `parseInboundRequest`, `formatInboundResponse`, `parseToolCall`, `formatToolResult`; simulator inbound conversations; harness scenarios.
- ✅ P1B-INB-4 `POST /inbound/:vendor` (tenant from the called number only): admission, attempt row (idempotent on vendor call id), caller contact, identity from caller ID, rendered greeting + prompt + tools.
- ✅ P1B-INB-5 Tools (AGENTS §5.9): `lookup_orders`, `verify_caller`, `search_knowledge`, `confirm_order`, `request_cancellation` (two-step), `request_address_change`, `create_ticket`, `transfer_to_human`, `register_opt_out`; each with identity/setting checks, `agent_actions` row, latency test, and a negative test for an unverified caller.
- ✅ P1B-INB-6 Inbound prompt renderer + profile validator (disclosure first, guardrails, tools, pinned facts) in `call-scripts`; `inbound_support_v1` extraction.

**CORE — Data the agent needs**
- ✅ P1B-CORE-1 Order cache from `orders/create|updated|cancelled|fulfilled` and `fulfillments/update` (intents-consumer); API ingestion for non-Shopify merchants (`PUT /v1/orders/:ref`).
- ✅ P1B-CORE-2 `actions` worker: executes approved agent cancellations via the Shopify write-back port (GraphQL client = P1-SHOP-2), retried, alerted; cancels a pending outbound COD intent for the same order (E-97).
- ✅ P1B-CORE-3 Results: inbound finalisation — outcome from `inbound_support_v1`, minutes metered (`billing_ledger.kind = 'minute'`, rounded up per call), `call.completed` + `ticket.created` merchant events.

**API — Merchant configuration**
- ✅ P1B-API-1 `/v1/inbound-profiles`, `/v1/knowledge`, `/v1/tickets`, `/v1/transfer-targets` (create + verify by attestation until a test-call verification exists), `/v1/orders`.

**ENG / OPS**
- ◐ P1B-ENG-1 Adapter for the P0 winner covering inbound + tools (`engines/<vendor>`), with recorded fixtures. *Code done for Bolna:* tools (bearer-token authenticated), and inbound through a variable-prompt agent per number with the called number signed into the lookup URL (`inbound:attach`); inbound is **off** (`BOLNA_INBOUND`) until verified, and cannot forward a refused call (Q-34). OmniDimension has neither (Q-35).
- ✅ P1B-OPS-1 Runbooks: `inbound-fallback.md` (what callers hear when the agent cannot answer, and how to change it), `agent-action-failed.md`.
- P1B-OPS-2 Latency dashboard: context and tool p50/p95 per engine; alert when p95 > budget for 5 minutes.

### Exit criteria
- On the simulator: an end-to-end inbound suite covering every AGENTS §5.9 tool with verified, unverified and foreign-order callers; cancellation two-step; transfer in/after hours; withheld caller; fallback paths — green in CI.
- Live (after engine + number): Client A's support number forwarded to Naaradh for ≥ 2 weeks; ≥ 300 inbound calls; ≥ 50% resolved without a human; zero order data disclosed to an unverified caller (audit query over `agent_actions`); tool p95 < 700 ms measured at `voice`.

### Kill / pivot criteria
- Tool round-trips on real networks make callers hang up (abandon rate > 25% during tool calls) on every engine → simplify to FAQ + ticket + transfer (no live order tools) while self-hosting is evaluated.
- Merchants will not forward their support number → offer a new number printed on invoices/packaging; measure call volume before investing further.

### Metrics
Calls answered, resolution rate (no human), transfer rate, ticket rate, abandon rate, average handle time, minutes per call, tool latency p95, verification success rate, cancellations executed vs ticketed, cost per minute vs price per minute.

---

## Phase 2 — Shopify app + compliance layer + dashboard (Weeks 7–10)

**Goal:** The public embedded Shopify app a new merchant can install and be live with COD confirmation in ten minutes; the full compliance layer; a merchant dashboard that shows outcomes in business terms.

**Entry criteria:** Phase 1 exit; DLT telemarketer application submitted (P2-LEG-1 starts immediately if GST is ready).

**Status (13 Sep 2026):** built under the founder sequencing note (code first, entity and DLT after). Everything a developer can finish without a live Partner app, dev store, engine or registration is done and tested: compliance layer, billing (Shopify + Razorpay), dashboard, staff console, embedded app, notifications, infra-as-code. Open: the live exit criteria, the human steps (P2-LEG-1/2, P2-SHOP-6 submission, P2-SHOP-8), the Flow trigger (P2-SHOP-7) and the BigQuery export job (P2-WEB-2 / P2-INF-2).

### Workstreams

**LEG / CMP**
- P2-LEG-1 Register Naaradh as **Telemarketer (Aggregator)** on one TSP DLT portal (₹5,000 + GST); document rejections and fixes. `[VERIFIED fee]`
- P2-LEG-2 Merchant PE registration guide + in-app step; PE↔TM linkage tracking (`tenants.dlt_pe_id`, `dlt_linked_at`).
- ✅ P2-CMP-1 Consent ledger service (`recordConsent`, `revokeConsent`, expiry rules per region), suppression service (global/tenant, purpose scoping, 90-day opt-out), complaint intake + counters + auto-pause (E-05), template registry (DLT template IDs), DND scrub client with fail-closed for promotional, disclosure validator wired into script publishing. Complaint intake: `complaint_reports` queue (migration 0007), attribution to the last outbound caller within 30 days, unattributed → global suppression; `complaints` worker; `/v1/complaints`; runbook `complaint-received.md`. DND scrub client waits for a TSP/DLT account (P2-LEG-1).
- ◐ P2-CMP-2 Public `/do-not-call` page → global suppression within 24 h; `dnc@` mailbox workflow. Backend done: `POST /v1/public/dnc` (suppression immediately, per-IP and per-phone limits, `submit_dnc_request()`); the page ships with `web`.
- ✅ P2-CMP-3 Erasure workflow (`erasure_requests`) covering GCS, transcripts, contacts, tombstones; tested end-to-end. `retention` worker, `/v1/erasure-requests`, runbook `erasure-request.md`.
- ✅ P2-CMP-4 Retention job per tenant setting (media via `call_attempts.media_purged_at`, order cache 180 days).

**SHOP — Public app**
- ✅ P2-SHOP-1 Scaffold `shopify` (Shopify CLI React Router template, ADR-0007), embedded, session tokens, App Bridge, Polaris; `shopify.app.toml` with pinned API version, scopes (minimum set), all webhooks incl. mandatory compliance topics (`customers/data_request`, `customers/redact`, `shop/redact`) with HMAC + 401 behaviour. `[VERIFIED]` Done: `shopify` (sessions sealed in Postgres via definer functions, ADR-0009), `shopify.app.toml` pointing every topic at hooks.
- ◐ P2-SHOP-2 Onboarding flow (SPEC §8.4): business details, compliance step (PE), use-case selection, script review + approval, voice/language, behaviour settings (auto-cancel off, address write off, retries, spend cap), test call, billing, go-live. Done: checklist, business details, compliance clickwrap, script approval, behaviour settings, support-line setup, billing, go-live guard. Waits: the test call (needs an engine, P0-ENG), voice choice (engine voices).
- ✅ P2-SHOP-3 Billing via Shopify Billing API: `appSubscriptionCreate` recurring + usage lines, `cappedAmount` = spend cap, `appUsageRecordCreate` per billable outcome (idempotent by `outcome_id`), `app_subscriptions/update` handling, capped → pause (E-61). `[VERIFIED requirement]` Backend done (ADR-0008): SDK operations, `billing_subscriptions`, usage records keyed by ledger id, subscription sync, capped/frozen. Approval flow in `shopify/app/routes/app.billing.tsx`. Live dev-store round-trip is an exit criterion.
- ✅ P2-SHOP-4 Uninstall flow: stop dispatch ≤ 60 s, purge on `shop/redact` (48 h), retain legal records (E-48). Uninstall also deletes the store's sealed Admin session; reinstall lifts only the uninstall pause.
- ✅ P2-SHOP-5 Hourly reconcile job (E-53); duplicate webhook idempotency (E-52); merchant-cancel cancellation path (E-40). `workers/src/reconcile/shopify-orders.ts` (Redis-locked hourly, watermark per store, same ingestion path as `orders/create`).
- ◐ P2-SHOP-6 Protected customer data **Level 2** request in Partner Dashboard with justification doc `docs/shopify/pcd-justification.md`; app tolerates `null` phone (gate `no_phone`). `[VERIFIED]` Justification written; submission is a human step.
- ◐ P2-SHOP-7 Shopify Flow trigger "Naaradh call completed" (metafields already written) `[VERIFY extension requirements]`. *Code done:* `extensions/call-completed-flow-trigger`, `fireCallCompletedTrigger` after each write-back behind `SHOPIFY_FLOW_TRIGGER`; needs a deploy of the extension.
- P2-SHOP-8 Staging Partner app + dev store test matrix (COD manual gateway, cancellation, uninstall/reinstall, billing decline).

**WEB — Dashboard + site**
- ✅ P2-WEB-1 `web` dashboard: calls list with outcome/reason, transcript viewer, recording player (signed URL), gated-reason explanations, settings, script editor with approval, numbers page, consent/suppression views, complaint log. Plus team/roles, API keys, access log (E-74), billing + disputes. Number reveal deferred (ADR-0009).
- ◐ P2-WEB-2 RTO analytics: baseline vs current (orders confirmed, cancelled pre-ship, RTO % by state/pincode band, ₹ saved) from BigQuery nightly export (phone hashed). Done: in-app counts; the nightly export (`workers-analytics`, Phase 3; facts carry no PII, state/pincode band null until the order cache stores a coarse band). Open: the baseline comparison view.
- ✅ P2-WEB-3 Marketing site pages: home, pricing (INR), how it works, `/privacy`, `/terms`, `/dpa`, `/aup`, `/security`, `/subprocessors`, `/cookies`, `/refunds`, `/contact`, `/grievance`, `/do-not-call`. Legal pages are drafts marked pending counsel.
- ✅ P2-WEB-4 Merchant notifications (Postmark): daily summary, gated-orders digest, complaint alert, spend-cap alert, billing events.

**BILL**
- ✅ P2-BILL-1 `billing` worker (ADR-0008): billing events → Shopify usage; ledger; nightly reconciliation report; margin per call with vendor cost (E-33) and FX capture (E-63).
- ◐ P2-BILL-2 Disputes: merchant dispute within 7 days from call page → admin review → credit note (E-62). Backend + API done (`POST /v1/outcomes/:id/disputes`, credit ledger rows, runbook); the review screen ships with the staff console.
- ✅ P2-BILL-3 Razorpay Subscriptions for non-Shopify Indian tenants (Client B) with GST invoices — `@naaradh/payments`, `/razorpay/webhooks`, monthly add-ons net of credits. GST invoices need the entity's GSTIN in the Razorpay account (P0-LEG).

**INF / OPS**
- ✅ P2-INF-1 Cloud Armor rules for `/hooks/*` (vendor IP allow-lists where published, rate limits), WAF preconfigured rules.
- ✅ P2-INF-2 BigQuery dataset + scheduled export; PII hashing in export. Dataset and table in Terraform; nightly load job in `workers/src/analytics` (Phase 3) — aggregates only, nothing to hash.
- ✅ P2-OPS-1 Runbooks: `complaint-received.md`, `erasure-request.md`, `billing-dispute.md`, `billing-postings.md`, `cli-health.md` (job + console page, Phase 3), `merchant-access.md`, `staff-console.md`, `deploy.md`.
- ✅ P2-OPS-2 Alerting: complaint counter increments, spend-cap hits, capped subscriptions, writeback failures, cert expiry. *Done (26 Sep 2026):* four log-based metrics and their alert policies in `infra/modules/monitoring` (`complaint_pause`, `dispatch_limit`, `writeback_failed`, `billing_capped`) plus certificate expiry; the dispatcher now logs a gate refused on a cap, a kill switch or a concurrency limit, and `workers/test/alert-filters.test.ts` fails if a filter stops matching the message it watches. Cloud SQL CPU does not apply (Neon, ADR-0004); Redis memory and Pub/Sub backlog cover the same ground.

### Exit criteria
- A brand-new dev store installs the app and places a live test call within 10 minutes without engineer help.
- Billing round-trip proven on a dev store (subscription + usage record + capped pause).
- Mandatory compliance webhooks pass Shopify's automated checks; HMAC-fail returns 401.
- DNC page, erasure, retention, complaint auto-pause all demonstrated in staging with synthetic data.
- Client A migrated from the custom app to the public app (staging → prod).
- Level 2 PCD request submitted.

### Kill / pivot criteria
- DLT telemarketer registration rejected twice for reasons that cannot be fixed → legal escalation; promotional use cases stay disabled.

### Metrics
Time-to-first-call for a new install, billing reconciliation delta (must be 0), gated-reason distribution, dashboard p95 load time.

---

## Phase 3 — Harden, legal, App Store submission (Weeks 10–12)

**Goal:** Production-grade security and operations, legal documents live, App Store review submitted.

**Entry criteria:** Phase 2 exit; TSP replies received (or documented as pending with lawyer's interim position). `[OPEN]`

### Workstreams

**SEC / INF**
- ◐ P3-INF-1 Execute SPEC §14 checklist end to end; each item ticked with evidence link. → `docs/security/checklist.md` (27 items with evidence; `applied`/`human` items wait for the first apply, the entity and counsel).
- ◐ P3-INF-2 Secret rotation runbook + first rotation; Workload Identity everywhere; no SA keys. → ✅ `docs/runbooks/secret-rotation.md`, previous-key window for `SHOPIFY_TOKEN_KEY`, re-encryption jobs (`workers/src/maintenance`, tested); first rotation pending (needs staging).
- ◐ P3-INF-3 Backup restore drill (`restore-drill.md`); PITR verified; RPO/RTO documented. → ✅ runbook + `scripts/restore-drill.sh` (Neon branch from timestamp) + `docs/security/restore-drills.md`; first drill pending (needs the Neon project).
- ✅ P3-INF-4 Load test (k6): `load/` scripts + `load` workflow (staging only) + `docs/runbooks/load-test.md`; chaos: `workers/test/int/chaos.test.ts` (Postgres/Redis failover under the running loops; every loop now on `runLoop` with backoff + `worker loop unhealthy` alert; pool error handler added), engine failures and duplicate/out-of-order webhooks in `e2e.test.ts`. Runs against staging pending.
- ✅ P3-INF-5 Audit logs (Admin + Data Access) exported to locked bucket, 1-year retention. → `infra/modules/audit-logs` (validated, not applied).
- ✅ P3-INF-6 `security.txt`, vulnerability disclosure page, dependency/container scanning gates enforced. → `/.well-known/security.txt`, Dependabot, CodeQL (+ existing trivy, gitleaks).
- ✅ P3-INF-7 Evaluate VPC Service Controls perimeter for prod `[VERIFY cost/complexity]`. → `docs/security/vpc-service-controls.md` (recommendation: defer).

**LEG**
- P3-LEG-1 Finalise with lawyer and publish: Terms (billable outcome definition, PE liability, AUP incorporation, arbitration), AUP, Privacy Policy (DPDP grievance officer), DPA, sub-processor list, refund policy, SLA template, merchant compliance attestation clickwrap. `[LEGAL]`
- P3-LEG-2 Employee/contractor NDA + data-handling policy + incident response plan (needed for Shopify Level 2). `[LEGAL]`
- P3-LEG-3 LUT filing for zero-rated export invoices (before first Shopify payout). `[CA]`
- P3-LEG-4 Decide DND-on-transactional flag and CLI `purpose_allowed` defaults **only after** TSP letters + legal opinion; record ADR-0002. `[OPEN]`

**SHOP**
- P3-SHOP-1 App Store listing: name, tagline, screenshots, demo video, pricing text (INR + note on usage billing), support email/URL, privacy URL, categories; ensure no unsupported claims.
- ◐ P3-SHOP-2 Pre-submission checklist (SPEC §8.6); internal review on a fresh dev store; mobile admin check. → ✅ `docs/shopify/pre-submission-checklist.md`; the review itself needs the Partner app.
- P3-SHOP-3 Submit for review; triage feedback; second-round budget (typical 1–4 weeks per round). `[VERIFY current timelines]`

**OPS**
- ◐ P3-OPS-1 On-call rota (even single-person), PagerDuty/Better Stack alerts, status page `status.naaradh.com`. → ✅ `docs/runbooks/on-call.md`, PagerDuty/webhook channels + SLO alert policies in `infra/modules/monitoring`; rota names and the status page are human.
- ✅ P3-OPS-2 Runbooks completed: `shopify-api-upgrade.md`, `restore-drill.md`, `engine-outage.md` (failover via `multi_engine_ok` + `ENGINE_SECONDARY_*` already documented); also `cli-health.md`, `load-test.md`, `on-call.md`, `secret-rotation.md`.
- P3-OPS-3 Support desk (Crisp/Intercom or shared inbox + Linear) with SLA targets per plan.

### Exit criteria
- SPEC §14 checklist 100% with evidence; load/chaos results within SLOs.
- Legal docs live at their URLs and versioned; clickwrap in onboarding.
- App Store submission accepted into review (or approved).
- ADR-0002 on CLI/DND written with sources attached.

### Kill / pivot criteria
- Shopify rejects for protected-data reasons that cannot be met → operate as unlisted/custom-distribution for Indian merchants (direct install links) while remediating; this delays distribution but not revenue.

### Metrics
Checklist completion, SLO attainment in load tests, review turnaround.

---

## Phase 4 — First 10 merchants + promotional use cases (Weeks 12–16)

**Goal:** Prove repeatable sales at outcome pricing; add abandoned-cart recovery with lawful consent capture; publish the case study.

**Entry criteria:** Phase 3 exit; DLT telemarketer registration active (required for promotional). Client A 30-day RTO delta available.

### Workstreams

**GTM**
- P4-GTM-1 Case study: Client A RTO before/after, ₹ saved, answer/confirm rates; permission signed.
- P4-GTM-2 Outreach list: 100 Indian D2C brands with high COD share (fashion, beauty, home); founder-led demos; target 10 paying by week 13.
- P4-GTM-3 Pricing validation: measure conversion at ₹8 vs ₹10 per confirmed order; adjust plan tiers; record ADR-0003 pricing.
- P4-GTM-4 Partnerships outreach: 3PL/RTO-scoring providers and one-click-checkout providers (leads into Phase 5).

**CMP / SHOP — Promotional**
- ◐ P4-SHOP-1 Checkout UI extension consent checkbox (custom wording covering calls/SMS/WhatsApp) → order attribute `naaradh_call_consent` → consent ledger (E-13). Wording approved by lawyer. `[LEGAL]`
- ◐ P4-SHOP-2 Abandoned checkout ingestion: Shopify `checkouts/create|update` (Shopify Checkout stores) with 45-min delay, 24-h expiry, max 1 call, DND scrub, template registration on DLT; opt-out line in script.
- ◐ P4-SHOP-3 Abandoned-cart script v1 + extraction (`recovered`, `will_buy_later`, `not_interested`, `price_objection`), resume-checkout link via SMS/WhatsApp (requires merchant's messaging provider or Naaradh's SMS via DLT-registered template `[VERIFY]`).
- ✅ P4-CMP-1 Promotional gate hardening: consent age (7 d), DND fail-closed, template ID on CDR mapping, complaint attribution by purpose.
- ✅ P4-CMP-2 Post-delivery feedback/NPS use case (promotional) behind the same consent gate.

**WEB / BILL**
- ✅ P4-WEB-1 Merchant self-serve script A/B (50/50) with metrics view.
- ✅ P4-WEB-2 Recovered-revenue analytics for abandoned cart; ROI page per use case.
- ◐ P4-BILL-1 Outcome definitions for promotional (`recovered` = order placed within 24 h by same phone/email, attribution window configurable) — recorded in Terms addendum. `[DECISION]`

**OPS**
- ✅ P4-OPS-1 Weekly recording QA sample (2% of calls) with a rubric; feed script improvements.
- ◐ P4-OPS-2 CLI health dashboard; rotate/retire at answer rate < 25% (E-28). Brought forward in Phase 3: nightly `answer_rate_7d` job, console Numbers page, `cli-health.md`; retirement stays a staff decision.

Terms addendum draft for counsel: `docs/legal/promotional-terms-addendum.md`.

Code status (16 Sep 2026, ADR-0010): SHOP-1 extension + cart block built, wording `TODO_LEGAL` (Q-08, Q-22), deploy is a human step; SHOP-2 built — DND waits for a TSP scrub provider (Q-02) and fails closed; SHOP-3 script + extraction built, the outcome is `will_complete` and the link is sent by the merchant (Q-21); BILL-1 attribution measured, not billed (Q-24).

### Exit criteria
- ≥ 10 paying merchants; ≥ 5,000 billable outcomes/month across tenants; gross margin per outcome ≥ 50%.
- Abandoned-cart live for ≥ 3 merchants with zero non-consented promotional calls (audit query).
- Complaint rate < 0.1% of calls; no tenant auto-pause triggered by real complaints.

### Kill / pivot criteria
- Merchants churn after month 1 because RTO delta < 20% relative → invest in script/AMD quality before further sales.
- Abandoned-cart answer/recovery rates too low to justify (recovery < 5%) → deprioritise in India; keep for US.

### Metrics
MRR, merchants, outcomes/month, GM per outcome, RTO delta per merchant, recovery rate, complaint rate, churn.

---

## Phase 5 — Integrations expansion (Weeks 16–23)

**Goal:** Be reachable from every stack an Indian SMB uses; add the appointment vertical.

**Entry criteria:** Phase 4 exit; API stable (OpenAPI published).

### Workstreams

**WooCommerce**
- ✅ P5-WOO-1 Plugin (`plugins/woocommerce`, GPL): settings (API key, use cases, script approval link), hooks `woocommerce_new_order`, `woocommerce_order_status_changed`, consent checkbox at checkout with stored wording version, abandoned-cart capture via AJAX + cart hash, order notes/meta writeback, i18n, nonces/capabilities.
- ◐ P5-WOO-2 WordPress.org submission (GPL, privacy disclosure of calls to `api.naaradh.com`, no obfuscation); handle review notes.
- ◐ P5-WOO-3 Test matrix: WP 6.x/PHP 8.x, COD gateway, popular Indian shipping plugins.

**One-click checkout providers (India)**
- ◐ P5-OCC-1 Partner/API access with GoKwik, Shiprocket Checkout, Razorpay Magic, Cashfree OCC for abandoned-checkout webhooks and RTO scores. `[OPEN]`
- ✅ P5-OCC-2 `intents-consumer` sources for each provider; consent flag mapping; gateway name normalisation updates (E-14, E-45). *Done (26 Sep 2026):* `occ/` maps GoKwik, Shiprocket, Razorpay Magic and Cashfree carts to the Shopify checkout shape; `POST /occ/<provider>/<tenant>.<tag>` verifies a per-tenant URL minted from `PROVIDER_WEBHOOK_KEY` before parsing, and the provider's signature on top where one exists (Cashfree required by default, a wrong signature always refused); the intents worker records the cart through the same `recordCheckout`, so consent, the 45-minute debounce and one call per cart are unchanged. Merchants connect it themselves in Dashboard → Developers. Cashfree's and Razorpay Magic's payloads are from their published references; GoKwik's and Shiprocket's are tolerant and `[VERIFY]` until a real delivery lands (docs/go-live/09 §3). Still open: P5-OCC-1, the partner access itself.

**CRM / Calendar / Automation**
- ◐ P5-CRM-1 Zoho CRM: new-lead → lead-callback intent; outcome → Activity/Note; consent field mapping. *Lead ingestion done (26 Sep 2026):* `crm/` reads a Zoho workflow webhook by field name (with per-merchant overrides in `integrations.metadata.crm.fields`) and `POST /crm/zoho/<tenant>.<tag>` verifies the per-tenant URL before parsing; the intents worker creates the `lead_callback` intent through the same `createIntent()` the API uses. Open: pushing the **outcome** back as an Activity/Note, which needs per-tenant OAuth — today a merchant receives outcomes through their own webhook endpoint (`POST /v1/webhooks`) or Zapier.
- ◐ P5-CRM-2 HubSpot: same as Zoho. *Lead ingestion done (26 Sep 2026)* — same route and parser, including HubSpot's `properties: { field: { value } }` shape. Same open half: the outcome push needs OAuth.
- ✅ P5-CAL-1 Cal.com + Google Calendar tools via engine adapter (`get_slots`, `book_slot`); appointment confirm/book/reschedule scripts; transfer-to-manager path; healthcare guardrails (no clinical advice, no report values).
- ✅ P5-AUT-1 Zapier/Make/n8n: "New outcome" trigger, "Create intent" action; docs pages.
- ✅ P5-API-1 SDKs generated from OpenAPI (JS, Python); webhook signature verification snippets.

**Vertical: appointments**
- P5-GTM-1 Pilot with 3 diagnostic labs/clinics/salons; outcome pricing per booked/confirmed appointment; case study.

Code status (16 Sep 2026, ADR-0011): one cart-ingestion
contract (`PUT /v1/carts/{ref}`) serves WooCommerce, one-click checkouts and bespoke stores, so
WOO-1 is built and OCC-2 needs no per-vendor parser until partner access exists (Q-09); the Woo
plugin is written but PHP is not linted or tested in this repo's CI (manual matrix in go-live 09);
CAL-1 ships a calendar port with a Cal.com adapter (`[VERIFY]`, Q-25), a manual diary, and the
`get_slots`/`book_slot` tools; Google Calendar waits for per-merchant OAuth; AUT-1 and API-1 are
documented recipes on the existing API rather than three more OAuth apps to maintain; CRM apps
wait for their vendor OAuth clients.

### Exit criteria
- WooCommerce plugin listed; ≥ 3 Woo merchants live.
- At least one OCC provider integration live; abandoned-cart coverage for non-Shopify-Checkout stores.
- Zoho + Cal.com flows live with ≥ 3 appointment-vertical tenants.

### Metrics
Installs by channel, share of intents by source, appointment confirm/booking rate, integration error rate.

---

## Phase 6 — US/EU launch (Weeks 23–31)

**Goal:** Same product, Western pricing, on region-isolated infrastructure with the right consent and disclosure flows.

**Entry criteria:** Phase 4 exit (stable core); legal budget for US/EU; Retell account.

Core audit before starting (16 Sep 2026): the
calling core already decides by recipient region (windows, consent, CLI pool, engine, disclosure
locale) and every gate is green; six defects were found and fixed. What Phase 6 must build, in
order of size: regional data isolation (one database and one recordings bucket today — needs an
ADR first), the Retell adapter, script templates for US/EU locales, a USD payment path, a US DNC
scrub provider. Decide the `*_paise` → `*_minor` renaming before any non-INR tenant exists.

### Workstreams

Started 19 Sep 2026 (code only, no accounts): ADR-0012 regional isolation — `DATA_REGION` per
deployment, refused in the gate (`tenant:other_region`), in inbound admission
(`inbound:other_region`, forwarded not dropped) and in every cross-tenant sweep; and P6-CMP-2
scripts for en-US, en-GB, de-DE, fr-FR, es-ES seeded by the merchant's country (non-English
wording needs a native review before approval).

Code for every remaining workstream landed 19 Sep 2026 — built and tested against stand-ins, no
account, no apply; what each still needs from outside the code is in
`docs/go-live/10-us-eu.md`, and the rules chosen pending counsel are Q-28–Q-33.

**INF**
- ◐ P6-INF-1 New GCP projects `naaradh-prod-us` (`us-central1`) and `naaradh-prod-eu` (`europe-west1`) from the same Terraform modules; tenant `data_region` routing; no cross-region PII. *Code done:* `infra/envs/prod-us.tfvars`, `prod-eu.tfvars`; `data_region` variable (drives `DATA_REGION`) validated against env and location; Stripe and region-sync secrets in the key-holder map; plan workflow matrix. Not applied.
- ◐ P6-INF-2 Separate Pub/Sub, Cloud SQL, GCS, Redis per region; shared DNS/LB with region-aware routing; status page per region. *Code done:* `region_directory` (no PII) published by each region's reconcile worker and pushed to peers, signed with each region's own Ed25519 key; hooks passes a verified Shopify webhook for another region's store through to that region before storing anything (ADR-0012 amendment 1). Status page per region not started.

**ENG**
- ◐ P6-ENG-1 `engines/retell` adapter (warm transfer with summary, Cal.com tools, HIPAA BAA where required); contract tests; capabilities flags. *Code done:* outbound calls, agents with our webhook and extraction fields, mid-call tools, signed webhooks, idempotency lookup; contract suite green on a stand-in (capability-aware harness). Declared off until verified (Q-31): inbound, warm transfer, cancel. Recorded payloads pending.
- ◐ P6-ENG-2 US/UK numbers via Retell (Twilio/Telnyx) with STIR/SHAKEN A-attestation `[VERIFY]`; CLI pools by region and purpose. *Code done:* `numbers.attestation` recorded by staff (audited); gate step 11 dials +1 recipients only from A. Numbers not bought (Q-28).

**CMP / LEG**
- P6-LEG-1 US: TCPA design review — prior express consent (transactional) vs prior express **written** consent (marketing); DNC scrubbing + SAN; state disclosure laws (e.g., California AB 2905); two-party recording states list; HIPAA BAA path for healthcare. `[LEGAL]`
- P6-LEG-2 EU/UK: ePrivacy Art. 13(3) opt-in for all automated calls; GDPR DPA (Art. 28) + DPIA; AI Act Art. 50 disclosure (already in scripts, verify wording per language); Germany all-party recording consent; UK PECR/TPS. `[LEGAL]`
- ◐ P6-CMP-1 Gate rules per region: consent source requirements, windows (state/country variants), DNC/TPS scrub providers, recording-consent question flow for two-party states/DE. *Code done:* per-purpose windows with day and holiday rules (US federal, French public holidays), explicit zone lists and area-code zone hints, recording-consent question in the first utterance (US, DE, AT, CH; nothing kept on refusal), US National DNC + UK TPS loaded from licensed files and failing closed when stale, spend caps per currency. `[LEGAL]` sign-off pending (Q-29, Q-32).
- ✅ P6-CMP-2 Scripts per locale (en-US, en-GB, de-DE, fr-FR, es-ES) with disclosure lines; extraction schemas unchanged. Cart recovery + appointment confirmation shipped; `[VERIFY: native review]` on de/fr/es.

**BILL / GTM**
- ◐ P6-BILL-1 Stripe subscriptions (USD/EUR/GBP), per-minute plans (SPEC §2.2); Shopify Billing already region-agnostic. *Code done (USD):* Checkout from the API (`POST /v1/billing/stripe/checkout`) and the dashboard, signed webhooks re-fetched before any change, usage as one invoice item per closed period. EUR/GBP wait on Q-30.
- ◐ P6-GTM-1 App Store listing localisation; US pricing page; outreach to Shopify Plus agencies; COD is rare in the US — lead with abandoned-cart recovery, appointment confirmation, and order-issue callbacks. *Code done:* `/pricing/us` from the catalogue's USD prices, marked early access, confirmation calls only.

### Exit criteria
- ≥ 5 US merchants live with consent-compliant flows; zero marketing calls without written consent (audit).
- EU launch only after DPIA + DPA sign-off and opt-in capture live; first EU tenant on `europe-west1`.

### Metrics
Per-minute gross margin (target ≥ 60%), US answer rates, compliance audit results.

---

## Phase 7 — Scale & optionality (Week 31+)

**Goal:** Expand the product surface and reduce vendor dependency where volume justifies it.

- P7-INB-1 ~~Inbound receptionist~~ — moved to Phase 1B (ADR-0006). What remains here: IVR-style menus, multiple profiles per number by time of day, inbound for non-commerce verticals.
- P7-ENG-1 Self-hosted engine evaluation (LiveKit Agents/Pipecat + Sarvam STT/TTS + Exotel SIP) once ≥ 50k minutes/month; ADR with cost/latency/quality comparison; adapter keeps product code unchanged.
- P7-ENT-1 Enterprise features: dedicated numbers, custom voices, SSO, audit exports, SLA tiers, India data-residency attestations, private connectivity.
- P7-LEG-1 Delaware C-Corp parent + Indian subsidiary **only if** raising US capital; structure with CA/lawyer (FEMA ODI, round-tripping). `[LEGAL]`
- P7-GTM-1 Channel partnerships (3PLs, checkout providers, Shopify agencies); referral program.
- P7-OPS-1 SOC 2 Type 1 readiness (policies already drafted in Phase 3), ISO 27001 roadmap if enterprise demand.

---

## Cross-phase tracks (run continuously)

| Track | Cadence | Owner |
|---|---|---|
| `docs/open-questions.md` review | Weekly | Founder |
| Recording QA sample + script tuning | Weekly | Founder/ops |
| CLI health + rotation | Daily automated, weekly review | Ops |
| Shopify API version upgrade | Quarterly | Eng |
| Secret rotation | Quarterly | Eng |
| Restore drill | Quarterly | Eng |
| Access review | Quarterly | Founder |
| Legal/regulatory watch (TRAI directions, DPDP rules, FCC/TCPA, EU AI Act guidance) | Monthly | Lawyer + founder |
| Vendor cost/margin review | Monthly | Founder |
| Complaint log review | Weekly | Founder |

---

## Dependency map (what blocks what)

- **Engine inbound + tool latency (P0-ENG-1B)** → Phase 1B live pilot. **Q-15 (inbound DLT treatment)** → live inbound on a real Indian number.
- **TSP CLI letters `[OPEN]`** → `numbers.purpose_allowed` defaults → promotional/transactional policy → Phase 3 ADR-0002 → Phase 4 promotional launch.
- **DLT telemarketer registration** → promotional use cases (Phase 4), template registration, PE linkage.
- **Pvt Ltd + GST** → DLT, Razorpay, telecom eKYC, Shopify payouts → Phase 2 billing.
- **Engine per-second billing `[OPEN]`** → outcome pricing viability → Phase 0 exit.
- **Shopify Level 2 PCD approval** → App Store listing (Phase 3); app must tolerate `null` phone until then.
- **Lawyer opinion on consent wording** → checkout consent checkbox (Phase 4) → abandoned cart.
- **Client A RTO baseline** → case study (Phase 4) → sales.
- **OCC provider partner access `[OPEN]`** → abandoned-cart coverage for most Indian stores (Phase 5).
- **DPIA + DPA** → EU launch (Phase 6).

---

## Risk register (top 10)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | No compliant CLI for non-BFSI service calls | Medium | Critical | TSP letters + legal opinion before scale; fallback: WhatsApp/SMS confirmation channel; appointment vertical |
| 2 | Vendor rounds billing to the minute | Medium | High | Confirm from invoice in Phase 0; choose vendor accordingly; negotiate per-second at volume |
| 3 | Hinglish quality poor on real networks | Medium | Critical | Bake-off gate; script simplification; engine switch via adapter |
| 4 | Complaint spike → telecom resource suspension | Low–Medium | Critical | Auto-pause thresholds, script QA, consent rigor, DNC page, new-tenant review window |
| 5 | Shopify review delays/rejections | High | Medium | Start Level 2 early; unlisted distribution as interim |
| 6 | Vendor repricing or outage | Medium | High | Secondary adapter ready; margin alerts; circuit breaker; contracts with notice periods |
| 7 | Regulatory change (TRAI/DPDP/FCC) | High | Medium | Monthly watch; rules as config/flags; compliance suite |
| 8 | Data breach of recordings | Low | Critical | CMEK, RLS, least privilege, audit logs, retention minimisation, IR plan |
| 9 | Merchant misuse (bought lists) | Medium | High | Consent gate fail-closed, AUP, suspension, attestation |
| 10 | Founder bandwidth | High | High | Ruthless phase gating; AI agents for well-specified tickets; hire ops help by Phase 4 |
| 11 | Agent says something untrue on an inbound call (policy, delivery date) | Medium | High | Facts only from tool results/articles; weekly transcript QA; merchant-editable pinned facts; tickets instead of guesses |
| 12 | Inbound tool latency causes dead air | Medium | High | 700 ms budget, filler lines, `voice` min instances, latency alerts, engine choice gated on P0-ENG-1B |

---

## Definition of "phase complete"

A phase is complete only when every exit criterion has linked evidence (query, screenshot, document, or test run) in `docs/STATUS.md`, kill criteria were evaluated and recorded, and the next phase's entry criteria are confirmed. Skipping a gate requires a written founder decision in the same file.

*Not legal advice. Timelines assume no material regulatory surprises; `[OPEN]` and `[LEGAL]` items are sequenced deliberately early so they cannot silently block later phases.*
