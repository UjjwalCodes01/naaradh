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
| Retell adapter (`packages/engines/retell`) | Built from the published API; contract suite green against a stand-in. Every `[VERIFY]` is open (Q-31) | **Yes** — until step 2 |
| Calling windows, holidays, recording consent | Conservative intersection in code (Q-29 `[LEGAL]`) | **Yes** — until counsel signs off (step 1) |
| National DNC (US, UK) | Loader, freshness checks and fail-closed screening built | **Yes** for marketing — until a list is loaded (step 5) |
| STIR/SHAKEN attestation | Gate dials +1 only from numbers recorded A (Q-28) | **Yes** — until numbers are checked (step 4) |
| Stripe (USD) | Client, checkout, webhooks, usage invoice items, dashboard form built | Yes for direct US merchants (step 6) |
| `prod-us`, `prod-eu` projects | Terraform written and validated; **nothing applied** | **Yes** (step 3) |
| Region directory + webhook forwarding | Built; single-region until peers are configured | Yes for US/EU Shopify stores (step 7) |
| `/pricing/us` | Live copy says "early access"; USD prices from the catalogue (Q-30) | — |

## 1. Counsel (P6-LEG-1, P6-LEG-2) — start first, longest lead time

Send US and EU counsel the rules the code applies today (`packages/compliance/src/constants.ts`,
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
2. Buy or port **one** test number in Retell (Twilio/Telnyx underneath) and add it in the staging
   console. No webhook is configured by hand: the dispatcher creates each Retell agent with its
   tenant-bound webhook URL on `hooks.stage.naaradh.com`.
3. Place one call per contract scenario to a team member's phone: happy path, no answer, busy,
   voicemail, opt-out, mid-call tool, agent hang-up. Save each webhook body and tool-call body.
4. Sanitise them (fake numbers from `packages/shared/test/fake-phones.ts`, no names, no
   recordings) and replace the shapes in `packages/engines/retell/test/fake-retell.ts`. Settle
   every `[VERIFY]` in `packages/engines/retell/src/` — signature header, cost units, reason
   names, tool body — and close Q-31's items one by one.
5. Ask Retell in writing about inbound (per-call dynamic variables from an answer URL), warm
   transfer and cancelling a queued call. Until they work, the adapter keeps declaring them off.

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
