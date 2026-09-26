# 10. United States and Europe (Phase 6)

**Audience:** the founder (and whoever helps) opening calls to US, Canadian, UK and EU customers.
**Date:** 19 Sep 2026. **Rules:** `docs/NAARADH_BUILD_SPEC.md`, ADR-0012 (one deployment per
region), `docs/open-questions.md` Q-28–Q-33.

The code for Phase 6 is built and tested against stand-ins: the Retell adapter, recipient-region
calling windows and holidays, recording consent, the US/UK do-not-call lists, STIR/SHAKEN
attestation, Stripe billing in dollars, the region directory and the `prod-us` / `prod-eu`
Terraform. **Nothing below has run against a real account, and no call to a +1 or +44 number can
happen until each step here is done.** Work top to bottom; later steps depend on earlier ones.

## Where things stand

| Area | State | Blocks live calls? |
|---|---|---|
| Retell adapter (`engines/retell`) | Built from the published API; contract suite green against a stand-in. Every `[VERIFY]` is open (Q-31) | **Yes** — until step 2 |
| Calling windows, holidays, recording consent | Conservative intersection in code (Q-29 `[LEGAL]`) | **Yes** — until counsel signs off (step 1) |
| National DNC (US, UK) | Loader, freshness checks and fail-closed screening built | **Yes** for marketing — until a list is loaded (step 5) |
| STIR/SHAKEN attestation | Gate dials +1 only from numbers recorded A (Q-28) | **Yes** — until numbers are checked (step 4) |
| Stripe (USD) | Client, checkout, webhooks, usage invoice items, dashboard form built | Yes for direct US merchants (step 6) |
| `prod-us`, `prod-eu` projects | Terraform written and validated; **nothing applied** | **Yes** (step 3) |
| Region directory + webhook forwarding | Built; single-region until peers are configured | Yes for US/EU Shopify stores (step 7) |
| `/pricing/us` | Live copy says "early access"; USD prices from the catalogue (Q-30) | — |

## 1. Counsel (P6-LEG-1, P6-LEG-2) — start first, longest lead time

Send US and EU counsel the rules the code applies today (`compliance/src/constants.ts`,
`WINDOW_RULES_*`, `recordingConsentFor`) and ask them to confirm or tighten, in writing:

- US federal and state calling hours and holiday bans; which states' mini-TCPA laws cover our
  purposes; whether a Shopify checkout checkbox is "prior express written consent" for cart
  recovery (E-SIGN).
- Which US states and EU countries need the callee's **consent** to record (the code asks in all
  of the US, DE, AT, CH, and keeps nothing on a refusal).
- Canada (CRTC hours, the National DNCL), France (Bloctel, décret 2022-1313), the UK (TPS/CTPS,
  PECR), and every other country before it is opened (Q-32).
- Data residency for UK merchants in the EU deployment (Q-33).

File the answers in `docs/legal/`, close Q-29/Q-32/Q-33, and change the constants only in a PR
that cites them. **Loosening a rule without that answer is not allowed.**

## 2. Retell account and recorded payloads (P6-ENG-1)

1. Create the Retell account (company email, 2FA), fund it, create an API key → Secret Manager
   `RETELL_API_KEY` in `naaradh-prod-us` (and `naaradh-prod-eu` if EU calls use the same account).
   New accounts get $10 of trial credit, which is enough for the whole bake-off.

   Four account settings to get right **before** the first call, because each one is a
   compliance answer you will be asked for later:

   - **Sign the BAA and the DPA** at `click-agreements.retellai.com` — self-serve, no fee, and
     the DPA includes the EU Standard Contractual Clauses. Do this before any EU personal data
     exists. File both alongside the other counterparty agreements.
   - **Set data retention to the shortest offered (one day).** It is configurable per agent, from
     1 day to 2 years. We persist the recording and transcript into our own CMEK bucket while
     handling `call_ended`, so the vendor's copy is a cache — keeping it for two years creates a
     second store of customer audio that we would have to answer for (ADR-0014).
   - **Set the PII storage control** per agent (everything / exclude PII / basic attributes).
     Start at the strictest setting the bake-off can live with and record which one you chose.
   - **Note the concurrency limit: 20 concurrent calls** by default on pay-as-you-go, per
     workspace. Raise it in Settings → Limits before a campaign, not during one. Bursting above
     it costs **$0.10/min on the whole call**, which would silently wreck a margin.

2. Buy or port **one** test number in Retell (Twilio/Telnyx underneath) and add it in the staging
   console. No webhook is configured by hand: the dispatcher creates each Retell agent with its
   tenant-bound webhook URL on `hooks.stage.naaradh.com`.

   **Retell sells US and Canada numbers only** ($2/month standard; toll-free $5/month plus
   $0.06/min inbound). A **UK or EU number cannot be bought here** — it has to be bought from
   Twilio/Telnyx and imported, or reached over a SIP trunk (§"Custom telephony"). Plan the UK
   launch around that: the number comes first, from the carrier, and Retell is pointed at it.
3. Place one call per contract scenario to a team member's phone: happy path, no answer, busy,
   voicemail, opt-out, mid-call tool, agent hang-up. Save each webhook body and tool-call body.
4. Sanitise them (fake numbers from `shared/test/fake-phones.ts`, no names, no
   recordings) and replace the shapes in `engines/retell/test/fake-retell.ts`. Settle
   every `[VERIFY]` in `engines/retell/src/` — signature header, cost units, reason
   names, tool body — and close Q-31's items one by one.
5. **Prove the three switched-off capabilities, one call each** (Q-31). All the code exists and
   is tested against the stand-in; each flag turns on only after you have watched it work.

   | Flag | The call to make | What proves it |
   |---|---|---|
   | `RETELL_INBOUND=true` | Attach the test number (`pnpm --filter @naaradh/workers inbound:attach`), then ring it from a mobile | Retell POSTs to the inbound URL **before** connecting; the greeting you hear is the one `admitInbound()` chose, not the one stored on the agent. Then ring it outside opening hours: you hear the closed message and the call ends — never a dead line. |
   | `RETELL_TRANSFER=true` | Ask the agent for a human while a verified transfer target is in hours | The agent dials the target from `{{naaradh_transfer_to}}`; the number never appears in the transcript. Check `transfer_started` / `transfer_bridged` arrive as webhooks. |
   | `RETELL_CANCEL=true` | Place a call, then cancel the order while it is ringing (E-40) | `POST /v2/stop-call` returns 204 and the phone stops ringing. Try it again on the same call: a call Retell cannot find must not become an error. |

   Two things to check while you are there, because both are assumptions in the code:
   - **`reject` is never sent.** Confirm a refused call is always *heard*. If a closed message
     ever arrives as silence or a carrier tone, that is E-92 and it blocks the US support line.
   - **The recording URL dies in about ten minutes.** Confirm the file is in GCS by the time the
     call appears in the dashboard. A failed persist is logged on the attempt and never retried —
     by the time a retry ran, Retell would have deleted the audio.

### What we deliberately do not switch on

Retell's platform includes a knowledge base, CRM sync, live A/B testing, an agent-editing
copilot, its own analytics and QA, and human takeover of a live call. **None of them are used**,
and the reasons are written down in [ADR-0014](../decisions/ADR-0014-what-we-rent-from-a-voice-engine.md):
each one moves the record of what happened outside our database, our RLS and our audit trail.
If a merchant asks for one, that is a product decision and a new ADR — never a dashboard toggle.

### A web call, before any number exists

`createWebCall` starts a call the merchant hears in their own browser: no number, no carrier, no
DLT, nothing dialled, and the greeting is still the approved first utterance, so the disclosure
is spoken as always. It is the cheapest way to let someone hear their agent during onboarding,
and it is the one part of the bake-off you can run on day one with no telephony at all.

The adapter method is built and tested. The browser half is **not** decided: joining needs
Retell's own browser client, and invariant 13 allows no vendor SDK outside `engines/<vendor>/`
(Q-36). Settle that before promising merchants a "hear your agent" button.

## 3. Google Cloud projects (P6-INF-1)

1. Create projects `naaradh-prod-us` and `naaradh-prod-eu` under the org, with billing, and an
   **org policy restricting resource locations** to `us-central1`/`us-east4` and
   `europe-west1`/`europe-west3` respectively.
2. Create the state buckets `naaradh-tfstate-prod-us` / `-prod-eu` in the same location.
3. Choose each region's managed Postgres (ADR-0012 §7; Neon in AWS us-east / eu-central, or
   Cloud SQL) and create the three roles exactly as `docs/runbooks/neon-bootstrap.md` does.
4. `pnpm tf:plan ENV=prod-us` (and `prod-eu`), review with a second person, then a human applies
   (`docs/runbooks/deploy.md`). Add secret versions: database URLs, Redis, phone keys (**new
   keys per region** — never copy India's), `ENGINE_WEBHOOK_KEY`, `RETELL_API_KEY`,
   `STRIPE_*`, `REGION_SYNC_PRIVATE_KEY` (see §7).
5. Run migrations with the `migrate` job; seed nothing.
6. DNS: `api|hooks|voice.us.naaradh.com` and `.eu.` to the new load balancers.

## 4. Numbers and attestation (P6-ENG-2, Q-28)

1. Buy US (and Canadian) numbers through Retell's carrier. Register the business and campaign
   with the carrier's caller-ID reputation programme if offered (reduces "Spam Likely").
2. For each number, place a test call to a handset that displays STIR/SHAKEN verdicts (or get
   the carrier's attestation report). Record the result in the console: **Numbers → the number
   → Attestation** (A/B/C, audited). The gate dials +1 recipients only from A.
3. Set `purpose_allowed` per number as in India.

## 5. Do-not-call lists (P6-CMP-1, Q-32)

1. US: register at telemarketing.donotcall.gov, get a **SAN**, and pay for the area codes you
   will call (or all). UK: buy a TPS (and CTPS if calling businesses) licence.
2. Load each list in its region — `docs/runbooks/dnc-registry.md`. Set calendar reminders at 25
   days. Without a fresh list, every marketing call there is refused `dnd:unknown`.

## 6. Stripe (P6-BILL-1)

1. Create the Stripe account for the company (or its US entity, per the accountant — Q-30).
2. Create one **recurring USD price** per plan code you sell (`starter`, `growth`, `scale`,
   `inbound_*` later) matching the catalogue's USD fee exactly; put the ids in
   `STRIPE_PRICE_IDS` (api and web, plain env in the tfvars `service_env`).
3. Add `STRIPE_SECRET_KEY` (restricted key: Checkout Sessions write, Subscriptions read/write,
   Invoice Items write) and the webhook endpoint `https://hooks.us.naaradh.com/stripe/webhooks`
   with events `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`; its signing secret
   is `STRIPE_WEBHOOK_SECRET`.
4. Test in Stripe test mode on staging first: subscribe from the dashboard's Billing page, pay
   with a test card, confirm the tenant becomes active; close a period and check the invoice item.
5. Decide sales tax / VAT handling with the accountant before the first live invoice (Q-30).

## 7. Region routing (P6-INF-2)

1. Generate one key pair per region (`docs/runbooks/region-directory.md#keys`): each private
   key into its own region's `REGION_SYNC_PRIVATE_KEY`; each public key into the other regions'
   `REGION_PEER_KEYS`.
2. Set `REGION_PEERS` and `REGION_PEER_KEYS` in each tfvars (`common_env`) — **including
   prod-in**, which today has neither: India's hooks is the only Shopify webhook URL, so until
   prod-in has peers it neither forwards US/EU stores' webhooks nor accepts their directories.
   Add `REGION_SYNC_PRIVATE_KEY` to prod-in's `enabled_optional_secrets` too. Apply.
3. Check `region_directory` in India fills with US shops within 10 minutes of the first US
   install, and that an order webhook for that store is logged `forwarded` in India and
   `published` in the US (`docs/runbooks/region-directory.md`).

## 8. Before the first US merchant

- [ ] Q-29 closed (counsel's written answer filed) and constants updated if tightened
- [ ] Retell payloads recorded, `[VERIFY]` settled, contract suite green on the recordings
- [ ] At least two A-attested numbers per purpose, answer-rate job running
- [ ] US DNC list loaded and fresh; reminder set
- [ ] Stripe live keys, prices and webhook verified end to end in test mode
- [ ] `ENGINE_DEFAULT_US=retell` confirmed in `prod-us.tfvars` after the recorded pass
- [ ] Privacy policy and DPA name the US/EU processing locations and sub-processors (Retell,
      its carriers, Stripe)
- [ ] One internal test merchant calls one team phone through the whole flow in `prod-us`
