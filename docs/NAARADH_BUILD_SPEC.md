# NAARADH — Two-Way AI Voice Agent for Commerce: Complete Build Specification

**Domain:** naaradh.com
**Cloud:** Google Cloud Platform
**Version:** 1.2 — 12 September 2026 (see Document history at the end)
**Status:** Pre-build. Nothing in this document is live.

---

## 0. How to read this document

Every statement is tagged so you never act on a guess:

| Tag | Meaning |
|---|---|
| `[VERIFIED]` | Read directly from a primary source (vendor docs, regulator text, Shopify docs) during research |
| `[VERIFY]` | Plausible and standard practice, but you must confirm against the live source before relying on it (pricing, API versions, limits change) |
| `[DECISION]` | A choice this spec makes; you can change it, but change it deliberately |
| `[LEGAL]` | Needs a lawyer / CA sign-off. Not optional. |
| `[OPEN]` | Genuinely unresolved. Do not build on an assumption here. |

**The three questions that can kill the business, listed first so they're never buried:**

1. `[OPEN]` Which CLI (caller-ID number series) can a non-BFSI Indian business legally use for AI-driven *service* calls (COD confirmation)? 1600-series is BFSI/Government only `[VERIFIED]`. 140-series is promotional-only per most operator guidance `[VERIFIED]`, but sources conflict. Resolve with written answers from TSPs before writing product code.
2. `[OPEN]` Does your chosen voice engine bill per-second or per-minute-rounded, and what is the minimum billable duration? A 40-second call billed as 60 seconds changes unit economics by 50%.
3. `[OPEN]` Is Hinglish call quality on real Indian mobile networks (4G, Jio/Airtel/Vi) acceptable to customers? Only a live bake-off answers this.

For **inbound** (the lead product since ADR-0006) question 1 changes shape: the customer dials the merchant, so CLI series for *placing* calls matters less — but whether an AI answering a 10-digit virtual number, and transferring the call to the merchant's staff, carries DLT/TCCCPR obligations is still `[OPEN]` (Q-15). A fourth question joins them:

4. `[OPEN]` Can the chosen engine hold a natural inbound conversation with **mid-call tool calls** (order lookup, verification, cancellation) inside ~1 s round-trips on Indian networks? A 3-second silence while the agent "checks" is where callers hang up. Only the bake-off answers this.

---

## 1. Product definition

### 1.1 What Naaradh is

A **vertical, two-way AI voice agent** that installs into a merchant's commerce stack and handles phone conversations with their customers in both directions (ADR-0006).

**Inbound — the lead product: the merchant's phone line, answered by AI, 24/7.**

- "Where is my order?" — status, tracking, expected delivery, for the caller's own orders
- "Cancel my order" — an unshipped COD order is cancelled after a two-step spoken confirmation, if the merchant allows it; otherwise a ticket
- "Change my address" / "I want a refund" — captured precisely as a ticket for the merchant, never acted on by the agent
- Policy and product questions — answered only from the merchant's published knowledge base
- "Let me talk to someone" — warm/cold transfer to a verified staff number inside business hours; after hours, a callback ticket
- Opt-out ("don't call me again") — honoured for all outbound calls

**Outbound — on the same agent, numbers, compliance layer and dashboard:**

- COD order confirmation (reduces RTO)
- Abandoned checkout recovery calls
- Appointment booking / confirmation / reminder
- Lead callback within minutes of form submission
- Delivery-failure re-attempt scheduling
- Post-delivery feedback / NPS

Merchants never "build an agent." They install, connect their store, point their support number at Naaradh (or take a new one), write or import their FAQs, and the line is answered; outbound use cases are toggles.

### 1.2 What Naaradh is NOT `[DECISION]`

- Not a horizontal "build your own voice agent" platform (that is Ravan, Bolna, OmniDim, Retell, Vapi).
- Not a voice engine. Naaradh rents STT/LLM/TTS + telephony through a provider adapter and can swap providers.
- Not a per-minute reseller for outbound in India. Outbound India pricing is per outcome; inbound is per connected minute (§2.2).
- Not a general-purpose receptionist for any business in v1. Inbound is scoped to **commerce support** (orders, delivery, returns, policies, callbacks) where Naaradh has the merchant's order data and can verify the caller. Clinics/salons (appointments) follow in Phase 5.

### 1.3 Positioning against Ravan.ai `[VERIFIED — from ravan.ai pricing/agni pages, Sept 2026]`

| Dimension | Ravan (Agni) | Naaradh |
|---|---|---|
| Category | Horizontal voice-agent platform | Vertical commerce app: support line (inbound) + outcome calls (outbound) |
| Buyer motion | Demo → "built for you in 7 days" → retainer | Self-serve install from Shopify App Store / WP.org |
| Pricing unit | Minutes (₹8/6/4 overage on INR plans; $0.08/0.06/0.04 on USD plans) | Outcomes (per confirmed order / per booked appointment) in India; per-minute or per-seat in US/EU |
| Effective ₹/min on included minutes | ₹10.0 / ₹6.0 / ₹5.2 (INR) — ₹21 / ₹16 / ₹12.5 (USD plans) | Not exposed to the merchant |
| Telephony | Shown separately (Twilio); excl. 18% GST | Bundled into outcome price |
| Distribution | Sales-led, founding access capped at 100 businesses | App stores + integrations |
| Where we don't compete | Latency, emotion, 100+ dialects, concurrency claims | — |

Ravan runs two price books (INR and USD) for the same product at ~2.4× difference. Naaradh does the same: build for India, price for the West.

### 1.4 The two existing clients

| Client | Stack | v1 use case | What you extract |
|---|---|---|---|
| Client A | Shopify | **Inbound support line** + COD confirmation | Calls answered without a human, % resolved by the agent, tickets created, transfer rate; RTO baseline → post-Naaradh RTO |
| Client B | Own website | Inbound line via REST API (order data pushed to Naaradh) + lead callback | Proof the platform is not Shopify-only; API surface hardening |

Both should move to the pilot price book (§2.2). Ask both for a written case study and a reference call. The inbound number to sell with: **% of calls resolved end-to-end by the agent** and **staff hours saved**.

---

## 2. Business model and pricing

### 2.1 Unit economics (India, COD confirmation) `[VERIFIED math, VERIFY inputs]`

Inputs: average confirmation call = 40–50 seconds; engine all-in cost ₹3–5/min (vendor dependent); FX ≈ ₹88/$ (check daily).

| Engine ₹/min | Cost per 45s call | Price ₹6 | Price ₹8 | Price ₹10 |
|---|---|---|---|---|
| ₹3 | ₹2.25 | 62% GM | 72% GM | 78% GM |
| ₹4 | ₹3.00 | 50% GM | 62% GM | 70% GM |
| ₹5 | ₹3.75 | 38% GM | 53% GM | 62% GM |

Merchant's reference points: human tele-caller ₹40–60/call; RTO loss ₹150–250/order `[VERIFY with Client A data]`.

Per-second billing is a hard requirement of the engine vendor. If the vendor rounds up to the minute, every row above worsens by 33–50%.

### 2.2 Price book `[DECISION — starting point, revise after pilot]`

**India (INR, excl. GST)**

| Plan | Platform fee | Included outcomes | Per extra outcome | Notes |
|---|---|---|---|---|
| Starter | ₹1,999/mo | 150 confirmed orders | ₹10 | One store, one use case |
| Growth | ₹4,999/mo | 500 | ₹8 | Up to 3 stores/use cases, abandoned cart |
| Scale | ₹12,999/mo | 1,500 | ₹6 | API access, priority support |
| Enterprise | Custom | Custom | ₹4–5 | Dedicated numbers, custom voice, SLA |

"Outcome" definitions must be precise (see §12.4 / E-60). Billable outcome = a call that reached a **human** and produced a definitive result: `confirmed`, `confirmed_with_changes`, `cancelled`, `rescheduled`, `booked`. Everything else — no-answer, busy, voicemail, wrong number, opt-out, inconclusive, transferred-without-outcome, superseded — is not billable. The full enum is in §6.5.

**India inbound (INR, excl. GST)** `[DECISION — founder to confirm; Q-17]`

| Plan | Platform fee | Included inbound minutes | Per extra minute | Notes |
|---|---|---|---|---|
| Starter | ₹2,499/mo | 500 | ₹6 | One number, one profile, knowledge base |
| Growth | ₹6,999/mo | 1,500 | ₹5 | Up to 3 numbers, transfer, order actions |
| Scale | ₹14,999/mo | 4,000 | ₹4 | API, priority support |

Metered per connected minute, **rounded up per call** (the pessimistic assumption until Q-04 confirms per-second vendor billing). At an engine cost of ₹3–5/min, per-minute resale at ₹4–6 is thinner than outcome pricing — inbound margin comes from the platform fee and included minutes, and must be re-checked against real call length from the pilot. Outbound outcome billing (above) is unchanged and runs alongside.

**US/EU/UK (USD)**

| Plan | Fee | Included minutes | Overage |
|---|---|---|---|
| Starter | $49/mo | 200 | $0.25/min |
| Growth | $149/mo | 800 | $0.20/min |
| Scale | $399/mo | 2,500 | $0.16/min |

Engine cost $0.06–0.09/min all-in `[VERIFY per vendor]`. Agencies in these markets resell at $0.20–0.35/min, so this is market-normal.

### 2.3 Billing mechanics

- India: Razorpay Subscriptions (INR, GST invoices, UPI/cards/net-banking). `[VERIFY current Razorpay subscription API]`
- Shopify merchants: **must** use Shopify Billing API for anything charged inside the app (App Store policy) `[VERIFIED — Shopify requires Billing API for app charges]`. Use `appSubscriptionCreate` with a recurring line + usage-based line (`appUsageRecordCreate` per billable outcome). Shopify takes its revenue share.
- US/EU direct: Stripe.
- Wallet/prepaid model for merchants who won't accept post-paid usage.
- Hard cap: every merchant sets a monthly spend cap; dispatcher stops at cap. Inbound has its own monthly minute cap; at the cap, calls forward to the merchant's own number instead of the agent (never dead air, E-92).

---

## 3. Legal entity, registrations, tax

### 3.1 Entity `[LEGAL]`

**Start:** Indian Private Limited Company. Required for PAN, GST, DLT registration, telecom KYC, Razorpay, and Shopify Partner payouts.

**Later (only if raising US capital or landing US enterprise contracts):** Delaware C-Corp as parent, Indian Pvt Ltd as subsidiary. Structure it with a CA + lawyer from the start; do not "flip" casually — FEMA ODI/round-tripping rules make a retroactive flip expensive. Delaware upkeep ≈ $1–2k/yr + Form 5472 (penalty $25k if missed) `[VERIFY current]`.

Dubai/other entities: not needed until GCC contracts justify it.

### 3.2 Registrations checklist (India)

| Item | Where | Needed for | Lead time |
|---|---|---|---|
| Company incorporation (SPICe+) | MCA | Everything | 1–3 weeks |
| PAN, TAN | Auto with SPICe+ | Tax | — |
| GST registration | GST portal | Invoicing, DLT, telecom KYC | 1–2 weeks |
| Bank account (current) | Any bank | Razorpay, payouts | 1 week |
| MSME/Udyam (optional) | udyamregistration.gov.in | Benefits, faster payments | 1 day |
| Startup India / DPIIT (optional) | startupindia.gov.in | Tax benefits, self-certification | 2–4 weeks |
| **DLT Telemarketer registration** | Any TSP DLT portal (Airtel, Jio, Vi, BSNL) | Legally placing commercial calls for others | Days to weeks; rejections common on doc mismatch |
| **Telecom eKYC** for each number purchased | Via TSP/CPaaS | Owning CLIs | Minutes (PAN + Aadhaar OTP + GST) `[VERIFIED — OmniDim flow]` |
| Trademark "Naaradh" (Class 9, 35, 38, 42) | IP India | Brand protection | 12–18 months to grant, file now |
| Razorpay merchant | razorpay.com | INR billing | 3–7 days |
| Shopify Partner account | partners.shopify.com | App | 1 day |
| Google Cloud Billing (Indian entity, GST) | console.cloud.google.com | Hosting | 1 day |

### 3.3 DLT roles `[VERIFIED]`

- **Principal Entity (PE)** = each merchant. Registers on a TSP DLT portal with PAN + address proof. ₹5,900 one-time on the first platform (free on subsequent). ~72 working hours approval.
- **Telemarketer** = Naaradh. Two sub-types: *Aggregator* (no direct operator connection, ₹5,000 + GST) or *Delivery* (direct operator connection, ₹50,000 + ₹900). Start as Aggregator behind Exotel/Plivo/Airtel.
- **PE ↔ Telemarketer linkage** must be active for every commercial call. Build "register as PE + link to Naaradh" into merchant onboarding as a required step for Indian merchants.
- **Liability:** TCCCPR holds the PE vicariously liable for its telemarketer's conduct. A contract does not shield a merchant from TRAI enforcement. Your Terms must say this plainly.

### 3.4 Tax notes `[LEGAL / CA]`

- GST 18% on domestic SaaS. Export of services to US/EU merchants is zero-rated under LUT — file LUT before first export invoice.
- TDS: Indian merchants may deduct TDS on your invoices; plan for it.
- Equalisation levy / OIDAR considerations if a foreign entity later sells into India.
- Shopify App Store payouts arrive from Shopify (foreign) → export income; keep FIRC/e-BRC records.

---

## 4. Regulatory compliance — the product is built around this

### 4.1 India

#### 4.1.1 Telecom (TRAI TCCCPR 2018 + amendments through 2026) `[VERIFIED unless tagged]`

| Rule | Detail | Product implementation |
|---|---|---|
| Number series | 140x = promotional/telemarketing only. 1600/1601 = BFSI (RBI/SEBI/IRDAI/PFRDA) and government only. 10-digit ordinary numbers prohibited for commercial calling. | `[OPEN]` CLI for non-BFSI service calls — resolve via TSP letters (Appendix A) |
| Transactional window | A call is transactional only if placed within **30 minutes** of a customer-triggered event | Dispatcher enforces `event_ts + 30min` hard deadline for COD confirmation; later calls are reclassified as service and require full consent stack |
| Explicit consent validity | Valid **7 days** for a specific purpose | Consent ledger stores purpose + timestamp; dispatcher checks age |
| Opt-out cooling period | **90 days** no-contact on that purpose after opt-out | Suppression list keyed on (phone, purpose, merchant) with expiry |
| Implicit consent | Only for duration of the contract between consumer and sender | For COD: valid until order delivered/cancelled |
| Calling window | 9:00–21:00 IST | Dispatcher timezone-aware window per recipient region |
| Auto-dialer disclosure | Must disclose auto-dialer/robocall at start of every call | First utterance template includes disclosure; logged as `ai_disclosed=true` with timestamp |
| DND/NCPR scrubbing | Before every promotional call | Scrub via TSP/DLT API per campaign; never for transactional? `[VERIFY — some TSPs scrub all]` |
| Templates | Registered content templates for promotional traffic | Template registry with DLT template IDs; map to CDRs |
| Penalties | ₹2L / ₹5L / ₹10L per successive violation; **5 valid complaints in a rolling 10-day window** can blacklist all telecom resources for up to a year across all TSPs | Per-merchant complaint counter: tenant auto-pause at **3**, global kill switch at **5** (E-05). These two numbers are the single source of truth; `compliance` implements them as named constants. |
| Digital Consent Acquisition (DCA) | Consent capture via DLT DCA framework | `[VERIFY]` whether DCA is required for voice or SMS-only; integrate if required |

#### 4.1.2 DoT / licensing `[VERIFIED]`

- **No OSP registration** required since DoT guidelines of Nov 2020 / June 2021. No bank guarantee, no domestic/international distinction, no audits.
- **No telecom licence** needed as long as Naaradh never carries voice itself. All calls originate through a licensed TSP/CPaaS.
- **Toll bypass is illegal.** Never terminate Indian calls via foreign SIP gateways or international CLIs. CALL-E's "International line" region for India is disqualifying for production `[VERIFIED — CALL-E README]`.

#### 4.1.3 Data protection — DPDP Act 2023 + Rules `[VERIFY current rules status; LEGAL]`

- Naaradh = **Data Processor** for merchants (Data Fiduciaries). Sign a processing agreement with every merchant (your DPA, §13).
- Purpose limitation: call data used only for the merchant's stated purpose.
- Data principal rights: access, correction, erasure. Build erasure by phone number across recordings, transcripts, ledger.
- Breach notification obligations to the Data Protection Board and affected principals `[VERIFY timelines in final rules]`.
- Recordings/transcripts stored in India (asia-south1/asia-south2) as default.
- Consent for recording: announce recording at call start (also good practice for two-party-consent jurisdictions).
- Children: never call numbers flagged as belonging to minors; not a realistic risk for COD but include a suppression flag.

#### 4.1.4 Other India

- **RBI/BFSI**: do not take BFSI/lending/collections clients in v1 — different number series, SRO codes, and RBI Fair Practices Code for recovery agents. Explicitly excluded in Acceptable Use Policy.
- **Healthcare**: diagnostics/clinics are fine for appointment booking; no clinical advice from the agent; no report values read out over the phone unless identity is verified `[DECISION]`.
- **Consumer Protection (E-commerce) Rules 2020**: your merchants' obligation; your agent must not make false claims about products/offers — scripts are merchant-approved and versioned.

### 4.2 United States `[VERIFIED — FCC/TCPA; VERIFY state law changes]`

- **TCPA**: FCC Feb 2024 ruling — AI-generated voices are "artificial or prerecorded voice." Prior express consent required for informational/transactional AI calls; **prior express written consent** for marketing (abandoned cart). Statutory damages $500–$1,500 per call. Private right of action = class-action risk.
- **National DNC Registry**: scrub marketing calls; SAN registration if placing marketing calls.
- **STIR/SHAKEN**: carrier handles attestation; use a carrier that gives A-attestation on your numbers.
- **State laws**: California AB 2905 (AI voice disclosure), Florida/Oklahoma mini-TCPAs, two-party recording consent states (CA, FL, IL, MD, MA, MT, NV, NH, PA, WA — `[VERIFY list]`). Default: announce recording + AI on every US call.
- **HIPAA**: healthcare merchants require a BAA; voice vendor must offer one (Retell does `[VERIFIED]`).
- **Inbound calls initiated by the consumer** do not require prior express written consent (relevant for v2).

### 4.3 EU / UK `[VERIFIED — regulation text; LEGAL for application]`

- **ePrivacy Directive Art. 13(3)**: automated calling systems require **prior opt-in consent**. Many member states apply this to all automated calls, marketing or not. Design assumption: opt-in required for every automated call to EU numbers.
- **GDPR**: lawful basis per purpose; DPA (Art. 28) with every merchant; DPIA for automated calling; records of processing; EU data residency option (GCP europe-west regions) or SCCs if processed in India.
- **EU AI Act Art. 50** (applicable from 2 Aug 2026): AI system must disclose at the start of the interaction that the person is talking to AI. Penalties up to €15M / 3% turnover. Logged disclosure field is mandatory.
- **Germany**: recording without all-party consent is a criminal offence (§201 StGB). Explicit consent question before recording or no recording.
- **UK**: PECR + UK GDPR; TPS scrubbing for marketing.
- Do not launch EU until: DPA, DPIA, opt-in capture, EU data residency, and a lawyer's sign-off exist.

### 4.4 Universal product rules (apply everywhere) `[DECISION]`

1. **Consent ledger is append-only**: (phone, merchant, purpose, source, evidence_uri, wording_version, captured_at, expires_at, revoked_at).
2. **AI disclosure** in the first 5 seconds of every call, logged as a structured field, not only in audio.
3. **Recording disclosure** in the same opening line.
4. **Verbal opt-out detection** ("don't call me", "stop calling", "remove my number") → immediate end of call + suppression entry + merchant notification.
5. **Calling windows** per recipient-region timezone, never per merchant timezone.
6. **Max attempts** per (phone, purpose): 2 in 24h, 3 total; then stop.
7. **Kill switches**: global, per merchant, per campaign, per engine.
8. **Complaint intake**: a public page naaradh.com/do-not-call with phone-number self-suppression, processed within 24h.
9. **No calls to emergency, premium-rate, or short-code numbers** (validate E.164 + number-type lookup).
10. **Script approval**: every merchant-facing script version is stored, approved by the merchant in-app, and referenced in each call record. Inbound agent profiles are versioned and approved the same way.
11. **Inbound: identity before information.** The agent reveals order data only for orders matching the caller's verified identity (caller ID match, or order number + pincode); anything that moves money or changes an address becomes a ticket for the merchant.
12. **Inbound: the agent acts only through Naaradh tools** — every lookup and action is validated, authorised and audited server-side; transfers go only to verified staff numbers, in hours.
13. **Inbound: never dead air.** If the agent cannot answer (paused, capped, kill switch, engine down), the call forwards to the merchant's own number or plays a closed message with hours.

---

## 5. Telephony and voice-engine strategy

### 5.1 Principle `[DECISION]`

Naaradh owns: merchant relationships, integrations, consent/compliance layer, dashboards, billing, and the call-outcome data. Naaradh rents: STT, LLM, TTS, media transport, and PSTN termination — through a single internal interface (`VoiceEngineAdapter`) so any vendor can be swapped without touching product code.

### 5.2 Engine candidates (Sept 2026) `[VERIFIED capabilities; VERIFY prices]`

| Vendor | India fit | Inbound | Transfer | Mid-call tools | Own numbers | Notes |
|---|---|---|---|---|---|---|
| **Bolna** | India-first: Hindi/Hinglish/vernacular; Exotel/Plivo/Twilio; ~₹5.52/min reported | Yes | Yes (multi-number, prompt-based) | Yes (custom API, Cal.com) | Yes | Ask about DLT telemarketer status, dial-time DND scrubbing, per-second billing |
| **OmniDimension** | +91 numbers via eKYC (PAN/Aadhaar/GST); Exotel import; SIP | Yes | Yes | Yes | Yes | Retail $0.084→$0.035/min; channels $6.74/mo each; **no DLT/TCCCPR mention anywhere in docs** — compliance is on you |
| **Retell** | Weak India depth; strong US healthcare (HIPAA BAA, Epic), transfer w/ context summary, Cal.com booking tools | Yes | Yes | Yes | Twilio/Telnyx/SIP | US/EU engine of choice; $0.07/min + LLM + telephony ≈ $0.13–0.31 all-in |
| **Vapi** | Weak India; most flexible; multi-vendor billing | Yes | Yes | Yes | Yes | Developer-heavy; cost opacity |
| **CALL-E** | India = "International line", testing only; no inbound, no cancel, no scheduling, unsigned webhooks | No | No | No | Limited | **Rejected for production**. Keep as a reference for task/goal-run API design. |
| **LiveKit Agents / Pipecat (self-hosted)** | Full control; Sarvam AI STT/TTS for Indian languages; Exotel/Plivo SIP | Yes | You build | You build | Via carrier | v2/v3 path once volume justifies 2–4 months of engineering |

`[DECISION]` India engine: bake-off Bolna vs OmniDim (direct API, not OmniRelay). US/EU engine: Retell. Self-host only after ≥50k minutes/month.

### 5.3 Telephony providers (India) `[VERIFY each]`

- **Exotel** — most common Indian CPaaS for voice; DLT-aware; SIP/number import supported by both Bolna and OmniDim.
- **Plivo** — Indian entity, good API, +91 numbers with KYC.
- **Airtel IQ / Jio / Vi enterprise** — direct TSP; needed for a Delivery-telemarketer setup later; also the ones to ask about CLI series.
- **Ozonetel / Knowlarity** — alternatives with dialer products.

Never use Twilio-originated foreign CLIs for Indian calls.

### 5.4 Vendor question list (send before signing anything)

1. Billing granularity: per-second or per-minute rounding? Minimum billable duration? Are unanswered / busy / voicemail attempts billed?
2. Indian +91 numbers: which carrier, which number series (140 / 1600 / 10-digit), under whose telecom licence?
3. Are you a DLT-registered telemarketer? Registration ID? How do you link my merchants as PEs?
4. Dial-time NCPR/DND scrubbing — where in the flow, and is it configurable per call type?
5. Who is telemarketer-of-record for TRAI complaints — you, me, or the merchant?
6. Concurrency: included channels, cost per extra channel, burst behaviour, per-org or per-number.
7. Latency p50/p95 to Indian mobiles; barge-in/interruption handling; Hinglish code-switch quality.
8. Call transfer: warm vs cold, context summary passed to human, transfer to Indian mobile numbers.
9. Webhooks: signed? retry policy? event types? Full transcript + recording URL + structured extraction?
10. Recording storage location and retention; can recordings be stored in my GCS bucket in asia-south1?
11. INR invoicing with GST? Or USD only (FX risk)?
12. DPA available? Sub-processor list? SOC 2 / ISO 27001 reports?
13. Rate limits, max campaign size, scheduling/cancel APIs.
14. Voicemail/AMD detection accuracy and whether AMD time is billed.
15. Do you enforce 9–21 calling windows, or is that on me?

### 5.5 `VoiceEngineAdapter` interface `[DECISION]`

```ts
interface VoiceEngineAdapter {
  createAgent(spec: AgentSpec): Promise<EngineAgentRef>;
  updateAgent(ref: EngineAgentRef, spec: AgentSpec): Promise<void>;
  placeCall(req: PlaceCallRequest): Promise<EngineCallRef>;      // outbound
  cancelCall?(ref: EngineCallRef): Promise<void>;                 // optional
  attachInboundNumber?(ref: EngineAgentRef, e164: string): Promise<void>; // v2
  parseWebhook(headers, rawBody): EngineEvent;                    // normalises to internal event
  fetchCall(ref: EngineCallRef): Promise<EngineCallSnapshot>;     // re-verify after webhook
  listNumbers(): Promise<PhoneNumber[]>;
  healthcheck(): Promise<HealthStatus>;
}

interface PlaceCallRequest {
  to: string;            // E.164
  from: string;          // CLI, must be in allowed pool for recipient region + call type
  agentRef: EngineAgentRef;
  variables: Record<string, string | number>;  // order_id, amount, customer_name...
  maxDurationSec: number;
  metadata: { tenant_id; campaign_id; call_id; purpose; script_version };
  webhookUrl: string;     // https://hooks.naaradh.com/engine/<vendor>/<hmac>
  amd: 'hangup' | 'leave_message' | 'continue';
  locale: string;         // 'hi-IN', 'en-IN', 'en-US'
}

type EngineEvent =
  | { type: 'call.ringing' }
  | { type: 'call.answered'; answered_by: 'human' | 'machine' | 'unknown' }
  | { type: 'call.transferred'; to: string }
  | { type: 'call.ended'; reason; duration_sec; billable_sec; recording_url?; transcript?: Turn[]; extracted?: Record<string, unknown> }
  | { type: 'call.failed'; code; message };
```

Every vendor gets its own implementation in `engines/<vendor>/`. Product code never imports a vendor SDK directly.

---

## 6. System architecture on Google Cloud

### 6.1 Region and residency `[DECISION]`

- **Primary region: `asia-south1` (Mumbai)**. Secondary: `asia-south2` (Delhi) for backups/DR. Indian PII, recordings, transcripts never leave India by default.
- **US tenants:** `us-central1` (or `us-east4`) project/partition. **EU tenants:** `europe-west1`/`europe-west4`. Tenant `data_region` decides where its rows and objects live. Simplest v1: one deployment in India serving India only; add US/EU deployments as separate GCP projects with identical IaC when those markets open.
- Cloud SQL, GCS, Memorystore, Pub/Sub topics all created per region; no cross-region replication of PII.

### 6.2 GCP project structure

```
naaradh-org (Cloud Identity / Organization)
├── naaradh-shared            # Artifact Registry, Cloud Build, Cloud DNS (naaradh.com), Secret Manager (shared), monitoring workspace
├── naaradh-prod-in           # Production, asia-south1
├── naaradh-stage-in          # Staging, asia-south1
├── naaradh-dev               # Dev sandbox
└── (later) naaradh-prod-us, naaradh-prod-eu
```

- Separate billing sub-accounts per project. Budget alerts at 50/80/100%.
- Org policies: restrict resource locations to allowed regions; disable default network; require CMEK for buckets holding recordings `[DECISION]`.

### 6.3 Services and what each does

| Component | GCP service | Purpose | Notes |
|---|---|---|---|
| **api** | Cloud Run (min instances 1) | REST for dashboard, merchant API, Shopify app backend | `[DECISION: Fastify 5 + Zod on Node 22 / TypeScript]` — NestJS was evaluated and rejected for weight; see AGENTS.md §2.4 |
| **web** | Cloud Run or Firebase Hosting | Merchant dashboard (Next.js), marketing site | `app.naaradh.com`, `naaradh.com` |
| **hooks** | Cloud Run (separate service) | All inbound webhooks: Shopify, Woo, engine vendors, Razorpay, Stripe | Public, HMAC-verified, writes to Pub/Sub only, returns 200 fast |
| **voice** | Cloud Run (min 2, CPU always allocated) | Synchronous agent runtime: inbound admission, per-call prompt + tools, mid-call tools (identity, orders, knowledge, cancellation, tickets, transfer, opt-out) | ADR-0006. p95 < 500 ms context, < 700 ms tools. Holds the staff decryption key only |
| **dispatcher** | Cloud Run Job or always-on Cloud Run consumer of Pub/Sub | Turns "call intents" into engine calls: consent check, DND, window, cap, concurrency, dedupe | The compliance brain; single writer to `call_attempts` |
| **scheduler** | Cloud Tasks + Cloud Scheduler | Delayed/retried dispatch (e.g., abandoned cart in 45 min; retry no-answer in 2h; 9 AM re-queue) | Cloud Tasks gives per-task `scheduleTime`, dedupe by task name |
| **results** | Cloud Run consumer | Normalises engine events, writes call records, computes outcome, triggers write-backs (Shopify tags, CRM), billing meter | Idempotent by `event_id` |
| **billing-meter** | Cloud Run consumer | Converts billable outcomes into Shopify usage records / Razorpay invoice lines / Stripe usage | Daily reconciliation job |
| **compliance** | Library + Cloud Run job | Consent ledger service, suppression lists, complaint counters, DND scrub cache, template registry | Exposed internally only |
| **recordings** | Cloud Storage (`asia-south1`, CMEK, Object Lifecycle) | Recording MP3/WAV + transcripts JSON | Signed URLs (15 min) for dashboard playback; retention default 90 days (merchant configurable 30–365) |
| **db** | Cloud SQL for PostgreSQL 16 (HA, private IP) | System of record | Row-level tenant isolation via `tenant_id` + RLS policies |
| **cache/queues** | Memorystore for Redis | Concurrency counters, rate limits, idempotency keys, per-merchant live call counts | Redis Cluster not needed v1 |
| **events** | Pub/Sub | Topics: `shopify.events`, `engine.events`, `call.intents`, `call.results`, `billing.events`, `dlq.*` | Dead-letter topics on every subscription |
| **secrets** | Secret Manager | Vendor keys, Shopify app secret, HMAC keys, DB creds | Rotated quarterly; accessed via service-account IAM only |
| **analytics** | BigQuery (scheduled export from Postgres via Datastream or nightly job) | RTO analytics, cohort reporting, finance | PII minimised: hash phone numbers in BQ |
| **observability** | Cloud Logging, Cloud Monitoring, Cloud Trace, Error Reporting; Sentry (optional) | SLOs, alerts | Log PII redaction via log exclusion + structured logging |
| **edge** | Global External HTTPS Load Balancer + Cloud Armor + Certificate Manager | TLS for all subdomains, WAF, rate limiting, geo-blocking | Cloud Armor rules: block non-target countries on hooks except vendor IPs |
| **DNS** | Cloud DNS | naaradh.com zone | See §7 |
| **CI/CD** | Cloud Build + Artifact Registry; GitHub as source | Build, test, deploy per environment | Terraform for all infra |
| **IaC** | Terraform (state in GCS bucket with versioning) | Reproducible environments | One module per component |

### 6.4 Network and security baseline

- Custom VPC per project; Cloud Run services use Serverless VPC Access (or Direct VPC egress) to reach Cloud SQL/Redis on private IP. No public IP on DB/Redis.
- Cloud SQL: private IP, SSL required, automated backups (daily, 30-day retention), PITR enabled, HA in prod.
- Service accounts per service with least privilege; no default compute SA.
- Workload Identity Federation for GitHub Actions/Cloud Build (no long-lived keys).
- Cloud Armor: OWASP preconfigured rules, per-IP rate limit on `/hooks/*` and `/auth/*`, allow-list vendor webhook IP ranges where published.
- All webhook endpoints verify HMAC (Shopify) or vendor signature; if a vendor's webhooks are unsigned (CALL-E-style), treat payload as untrusted and re-fetch the call by ID before acting `[DECISION]`.
- Egress: static NAT IPs (Cloud NAT) so vendors can allow-list Naaradh.
- Secrets never in env files; Cloud Run mounts from Secret Manager.
- CMEK (Cloud KMS) for recordings bucket and Cloud SQL `[DECISION]`.
- VPC Service Controls perimeter around prod project once stable `[VERIFY complexity/cost]`.
- Audit logs: Admin Activity + Data Access logs enabled for GCS/Cloud SQL; exported to a locked bucket, 1-year retention.

### 6.5 Data model (Postgres) — core tables

```sql
tenants(id, name, region, country, entity_type, gstin, pan, dlt_pe_id, dlt_linked_at, status, spend_cap_paise, created_at)
users(id, tenant_id, email, role, mfa_enabled, last_login_at)
integrations(id, tenant_id, kind ENUM('shopify','woocommerce','api','zoho','hubspot','calcom','gcal'), external_id, credentials_secret_ref, scopes, installed_at, uninstalled_at)
use_cases(id, tenant_id, kind ENUM('cod_confirm','abandoned_cart','appointment_confirm','appointment_book','lead_callback','delivery_reschedule','feedback'), enabled, config JSONB)
scripts(id, tenant_id, use_case_id, version, locale, body JSONB, dlt_template_id, approved_by_user_id, approved_at)   -- immutable per version
numbers(id, tenant_id NULL, e164, region, series ENUM('140','1600','10digit','intl'), provider, engine, purpose_allowed[], status)
contacts(id, tenant_id, phone_e164, phone_hash, name, locale_hint, timezone, source, created_at)   -- phone encrypted at rest (pgcrypto/app-level)
consents(id, tenant_id, phone_hash, purpose, source ENUM('checkout','form','api','import','verbal','dca'), evidence_uri, wording_version, captured_at, expires_at, revoked_at)  -- append-only
suppressions(id, tenant_id NULL (global), phone_hash, purpose NULL (all), reason ENUM('opt_out','complaint','dnd','invalid','manual','minor'), until, created_at)
call_intents(id, tenant_id, use_case_id, contact_id, external_ref (order_id/checkout_id/lead_id), purpose, event_ts, not_before, not_after, priority, status, variables JSONB, idempotency_key UNIQUE)
call_attempts(id, intent_id, attempt_no, engine, engine_call_id, from_e164, to_e164, scheduled_at, started_at, answered_at, ended_at, answered_by, end_reason, duration_sec, billable_sec, cost_paise_engine, cost_paise_telephony, recording_uri, transcript_uri, ai_disclosed_at, recording_disclosed_at, transferred_to, status)
call_outcomes(id, attempt_id, outcome outcome_enum, confidence, extracted JSONB, billable BOOLEAN, billed_at, writeback_status)

-- Inbound (ADR-0006)
inbound_profiles(id, tenant_id, name, version, locale, greeting, persona, business_hours JSONB, tools_enabled[], pinned_facts[], fallback_forward_enc, transfer_target_id, max_duration_sec, max_concurrent, max_calls_per_caller_hour, monthly_minute_cap, agent_cancel_enabled, status)
numbers.inbound_profile_id  -- which profile answers this number
knowledge_articles(id, tenant_id, title, body, locale, tags[], status draft|published, search tsvector)   -- FTS
orders(id, tenant_id, source, external_id, name, phone_hash, pincode_hash, payment_kind cod|prepaid, financial_status, fulfillment_status, cancelled_at, total_minor, currency, item_summary, tracking JSONB, placed_at)   -- minimal cache, no names/addresses
support_tickets(id, tenant_id, attempt_id, contact_id, order_id, category, summary, callback_requested, preferred_time, status open|resolved, resolved_by, resolved_at)
agent_actions(id, tenant_id, attempt_id, tool, args_scrubbed JSONB, result JSONB, status, confirm_token_hash, token_expires_at, created_at)   -- append-only
call_attempts += inbound_profile_id, profile_version, caller_verification none|caller_id|knowledge, caller_verified_at, verified_order_ids[], verify_failures, admission_trace JSONB
outcome_enum += resolved | ticket_created | abandoned | spam   -- inbound, never outcome-billed

-- outcome_enum, grouped by billability. Billable set is fixed by E-60 / CLAUDE.md invariant 11;
-- changing which values are billable requires an ADR. Adding a NON-billable value does not.
outcome_enum:
  -- BILLABLE (human answered + definitive result)
  'confirmed' | 'confirmed_with_changes' | 'cancelled' | 'rescheduled' | 'booked'
  -- NON-BILLABLE: no human / no definitive result
  | 'no_answer' | 'busy' | 'voicemail' | 'no_response' | 'inconclusive' | 'failed'
  -- NON-BILLABLE: wrong or protected recipient
  | 'wrong_number' | 'minor_answered' | 'opt_out' | 'recording_refused'
  -- NON-BILLABLE: handed off or overtaken by events
  | 'transferred' | 'transfer_failed' | 'callback_requested' | 'needs_merchant_action'
  | 'convert_to_prepaid_requested' | 'outcome_superseded'
campaigns(id, tenant_id, use_case_id, name, source, total, dispatched, completed, status, window_start, window_end, max_concurrency)
complaints(id, tenant_id, phone_hash, source ENUM('trai','merchant','self_service','vendor'), received_at, resolved_at, notes)
billing_ledger(id, tenant_id, kind ENUM('platform_fee','outcome','minute','credit','refund'), qty, unit_paise, total_paise, ref, period, invoiced_at, provider_ref)
audit_log(id, tenant_id, actor, action, target, before JSONB, after JSONB, at)   -- append-only
webhook_events(id, source, external_event_id UNIQUE, received_at, processed_at, status, payload JSONB)   -- idempotency
```

- Row-Level Security on every tenant table; API sets `SET app.tenant_id` per request.
- Phone numbers: store `phone_hash` (HMAC-SHA256 with a per-environment key) for lookups/suppression joins; store the encrypted E.164 only where needed to dial. Never log raw numbers.
- Retention job: recordings/transcripts per tenant retention setting; consents and suppressions retained 3 years `[LEGAL — verify DPDP/TCCCPR retention expectations]`.

### 6.6 Core flows

**COD confirmation (Shopify)**

1. `orders/create` webhook → `hooks` verifies HMAC → publishes to `shopify.events` (returns 200 in <500 ms).
2. Consumer checks: payment gateway is COD (`gateway`/`payment_gateway_names` contains manual/COD) and tenant use case enabled → creates `call_intent` with `event_ts=order.created_at`, `not_before=+2min` (give the merchant's other apps time), `not_after=+30min` (TRAI transactional window), idempotency key `shopify:<shop>:order:<id>:cod_confirm`.
3. Dispatcher gate (in order, each failure recorded with reason):
   - tenant active, not over spend cap, kill switches off
   - contact not in suppressions (global or tenant), not opted out for purpose
   - consent exists or purpose is transactional-within-window
   - recipient local time within 09:00–21:00; else reschedule to 09:00 next day **only if** still within transactional window (for COD it won't be — see edge case E-07)
   - DND scrub result for promotional purposes
   - per-tenant concurrency < limit; global engine concurrency < limit
   - number pool: pick `from` number allowed for (region, purpose)
4. `placeCall` → `call_attempt` row → engine dials.
5. Engine webhook events → `results` consumer → outcome + extraction (`confirmed: bool`, `cancel_reason`, `reschedule_to`, `address_change`) → write-back:
   - Shopify: add order tag `naaradh:cod-confirmed` / `naaradh:cod-cancelled` / `naaradh:no-answer-2`; add order note with summary; optionally `orderCancel` if merchant enabled auto-cancel; optionally update shipping address if merchant enabled and confidence ≥ 0.9.
   - Billing meter if outcome billable.
6. Merchant dashboard shows call, transcript, recording, outcome; RTO analytics updated nightly.

**Abandoned checkout** — same, but purpose = promotional: requires explicit consent record (checkout consent checkbox) and DND scrub; `not_before=+45min`, `not_after=+24h`; max 1 call; script must mention how to opt out.

**Appointment confirm/book** — intent from calendar/CRM event; tool call to Cal.com/Google Calendar for slots; transfer to human on request; outcome `booked/rescheduled/cancelled`.

**Inbound support call (ADR-0006)**

1. Customer dials the merchant's number (a Naaradh virtual number, or the merchant's own number forwarded to it). The engine calls `voice` → `POST /inbound/:vendor/:tag`.
2. `voice` verifies the signature, resolves the tenant **from the called number only**, and runs `admitInbound()`: number routed, tenant active, `inbound` kill switches off, monthly minutes under cap, concurrency, per-caller abuse limit, engine healthy. Refused → forward to the merchant's own number or a closed message with hours.
3. Admitted → an inbound `call_attempts` row; caller contact upserted (public-key encrypted; withheld caller → identity `none`); identity `caller_id` if the caller's hash matches a cached order. Returns greeting (AI + recording disclosure first), system prompt (guardrails + profile + hours + pinned facts), tools, variables.
4. During the call the agent calls tools on `voice`: `lookup_orders`, `verify_caller`, `search_knowledge`, `request_cancellation` (two-step), `request_address_change` (ticket), `create_ticket`, `transfer_to_human`, `register_opt_out`. Each is authorised against identity and tenant settings and written to `agent_actions`.
5. Approved cancellations are executed by the `actions` worker against Shopify (retried, then alerted); tickets appear in the dashboard and fire `ticket.created` to the merchant.
6. Call events flow through `hooks` → `results-consumer` exactly as outbound: recording + transcript to GCS, disclosure guard, outcome (`resolved`, `ticket_created`, `transferred`, …), minutes metered into the ledger, merchant `call.completed` webhook.

### 6.7 Concurrency, throughput, sizing `[VERIFY with vendor limits]`

- Channels needed = (calls per hour × avg call minutes) / 60, plus 30% buffer. 1,000 COD orders/day concentrated 10:00–20:00 ≈ 100/hour × 0.75 min / 60 ≈ 2 channels; buy 5 per tenant-tier pool.
- Redis token bucket per tenant and global; dispatcher backs off when engine returns 429.
- Cloud Run: `api` min 1 / max 20; `hooks` min 1 / max 50 (webhook bursts on Shopify flash sales); consumers min 1 / max 10.

### 6.8 Observability and SLOs

- SLOs: webhook ack p99 < 800 ms; intent→dial p95 < 90 s inside window; results processing p95 < 60 s after engine event; dashboard availability 99.9%.
- Alerts: engine error rate > 5% in 5 min; no engine events for 10 min during window; DLQ depth > 0; complaint counter increments; spend-cap hits; Cloud SQL CPU > 80%; certificate expiry.
- Structured logs with `tenant_id`, `call_id`, `intent_id`; PII redaction middleware; recordings never logged.
- Status page (`status.naaradh.com`) via a hosted status provider `[DECISION: Better Stack / Instatus]`.

### 6.9 Environments and CI/CD

- Branches: `main` → prod (manual approval), `develop` → staging (auto), PR → ephemeral preview (Cloud Run revision tags).
- Cloud Build triggers: lint, typecheck, unit, integration (Testcontainers Postgres/Redis), contract tests against engine mocks, Terraform plan; prod deploy requires plan approval.
- Database migrations: Drizzle + drizzle-kit, forward-only; run as a Cloud Run Job before deploy.
- Feature flags: simple table-backed flags per tenant (no external SaaS needed in v1).
- Seed data for staging: fake merchants, fake numbers routed to an engine "simulator" that returns scripted events.

### 6.10 Backups, DR, retention

- Cloud SQL automated daily backups + PITR (7 days); weekly logical dump to a cold GCS bucket in `asia-south2`.
- GCS recordings: versioning off, soft delete 7 days, lifecycle delete at tenant retention.
- RPO 1 hour, RTO 4 hours for v1 `[DECISION]`.
- Quarterly restore drill documented in runbook.

### 6.11 Monthly cost estimate (India prod, early stage) `[VERIFY — GCP pricing changes; use the calculator]`

| Item | Est. USD/mo |
|---|---|
| Cloud Run (5 services, low traffic, min instances) | 60–150 |
| Cloud SQL Postgres (2 vCPU, 8 GB, HA, 100 GB) | 250–350 |
| Memorystore Redis 1 GB (basic) | 35–50 |
| Pub/Sub, Cloud Tasks, Scheduler | 5–20 |
| GCS (1 TB recordings, egress for playback) | 25–50 |
| Load balancer + Cloud Armor | 25–60 |
| Secret Manager, KMS, Logging (with exclusions), Monitoring | 20–60 |
| BigQuery (small) | 5–20 |
| **Total infra** | **≈ $430–760/mo** |

Voice engine + telephony is the dominant cost and scales with calls, not with infra. Use committed-use discounts on Cloud SQL after 3 months of stable load.

---

## 7. Domain, DNS, email, TLS — naaradh.com

### 7.1 DNS zone (Cloud DNS) `[DECISION — subdomain plan]`

| Host | Type | Target | Purpose |
|---|---|---|---|
| `naaradh.com` | A/AAAA | Global LB IP | Marketing site |
| `www.naaradh.com` | CNAME | `naaradh.com` | Redirect to apex |
| `app.naaradh.com` | A | Global LB IP | Merchant dashboard |
| `api.naaradh.com` | A | Global LB IP | Public REST API (Client B, WooCommerce plugin) |
| `hooks.naaradh.com` | A | Global LB IP | All inbound webhooks (Shopify, Woo, engines, payments) |
| `voice.naaradh.com` | A | Global LB IP | Agent runtime: inbound context + mid-call tools (engines only; Cloud Armor allow-list vendor egress IPs where published) |
| `shopify.naaradh.com` | A | Global LB IP | Shopify embedded app host (App URL + redirect URLs) |
| `docs.naaradh.com` | CNAME | Docs host (Mintlify/Docusaurus on Firebase) | Developer docs |
| `status.naaradh.com` | CNAME | Status provider | Status page |
| `cdn.naaradh.com` | CNAME | Cloud CDN / GCS | Static assets, JS snippet for Client B |
| `mail` (MX) | MX | Google Workspace | hello@, support@, legal@, dpo@, dnc@ |
| `_dmarc.naaradh.com` | TXT | `v=DMARC1; p=quarantine; rua=mailto:dmarc@naaradh.com` | Email auth |
| `@` | TXT | SPF: `v=spf1 include:_spf.google.com include:<transactional-email-provider> -all` | Email auth |
| `google._domainkey` etc. | TXT | DKIM from Workspace + transactional provider | Email auth |
| `_github-challenge...`, Shopify/Google verification TXTs | TXT | As required | Ownership proofs |
| CAA | CAA | `0 issue "pki.goog"`; `0 issue "letsencrypt.org"` | Restrict cert issuers |

- Registrar: keep the domain wherever bought; set nameservers to Cloud DNS; enable registrar lock + 2FA; auto-renew; add a second admin contact.
- DNSSEC: enable in Cloud DNS and publish DS at registrar `[VERIFY registrar supports]`.

### 7.2 TLS

- Google-managed certificates via Certificate Manager on the global LB (wildcard `*.naaradh.com` via DNS authorization).
- HSTS on all hosts (`max-age=31536000; includeSubDomains; preload`) after confirming no HTTP-only host exists.
- Shopify requires HTTPS for App URL and redirect URLs `[VERIFIED — Shopify app requirement]`.

### 7.3 Email

- Google Workspace for team mail.
- Transactional email (merchant notifications, magic links): Postmark or Resend `[DECISION]`; separate subdomain `mail.naaradh.com` for sending reputation.
- Mandatory addresses: `support@`, `legal@`, `privacy@` (DPDP grievance officer contact), `dnc@`, `security@` (+ `/.well-known/security.txt`).

### 7.4 Public pages required before launch

- `/privacy` (Privacy Policy), `/terms`, `/dpa`, `/aup` (Acceptable Use), `/do-not-call` (self-service suppression form), `/security`, `/subprocessors`, `/cookies`, `/refunds`, `/contact`, `/grievance` (DPDP grievance officer details).
- Shopify App Store listing links to privacy policy and requires a support email/URL `[VERIFIED]`.

---

## 8. Shopify app — full specification

### 8.1 App type and stack `[VERIFIED requirements; VERIFY exact CLI/API versions at build time]`

- **Public app, embedded in Shopify Admin**, distributed via Shopify App Store (required for discoverability; custom/unlisted apps can't be found by new merchants).
- Built with Shopify CLI + React Router template (`@shopify/shopify-app-react-router`; the Remix template is superseded — ADR-0007), **App Bridge** and **Polaris** web components. Embedded apps must use session tokens (JWT) for auth, not cookies `[VERIFIED — Shopify embedded auth requirement]`.
- Host on `shopify.naaradh.com` (Cloud Run behind LB). Shopify requires HTTPS, a valid app URL, allowed redirect URLs, and response within their timeouts.
- Use **Admin GraphQL API** (REST is legacy; new apps should be GraphQL-first `[VERIFIED — Shopify has been deprecating REST for new public apps]`). Pin an API version (e.g., `2026-07`) and upgrade quarterly.
- Use `shopify.app.toml` for config: scopes, webhooks (incl. compliance topics), app URL, embedded=true.

### 8.2 Access scopes (minimum) `[DECISION — request the minimum; Shopify reviews for minimisation]`

| Scope | Why |
|---|---|
| `read_orders` | COD order events, order status, payment gateway |
| `write_orders` | Add tags, notes, cancel order, edit shipping address on confirmation |
| `read_customers` | Marketing consent state, customer phone (protected data) |
| `write_customers` | Update SMS/WhatsApp marketing consent when a customer opts out verbally `[VERIFY policy on app-initiated consent updates]` |
| `read_checkouts` | Abandoned checkouts (`checkouts/create`, `checkouts/update`) |
| `read_shipping` / `read_fulfillments` | Delivery status for reschedule flow (v1.5) |
| `read_locales` | Store language for script defaults |

**Protected customer data** `[VERIFIED]`: because the app reads **phone and name**, it must be approved at **Level 2** (Level 1 + Level 2 requirements). Request access in the Partner Dashboard with a justification: "phone is required to place a confirmation call the merchant has enabled; name is used to address the customer." Level 2 requirements include data minimisation, encryption at rest and in transit, retention limits, audit logging, staff access controls, an incident response plan, and a privacy policy that discloses the processing. Apps not approved receive `null` in protected fields.

Also read `sms_marketing_consent` / `whatsAppMarketingConsent` on the customer and the order's `buyer_accepts_marketing` to decide whether promotional calls are allowed. Note: Shopify's consent framework has **SMS** and **WhatsApp** consent objects but no dedicated "voice call" consent object `[VERIFIED]`. See edge case E-13.

### 8.3 Webhooks to subscribe

| Topic | Use |
|---|---|
| `orders/create` | COD intent creation |
| `orders/updated` | Detect merchant-side cancellation → cancel pending intent |
| `orders/cancelled` | Cancel pending intent; if outcome was `confirmed`, note conflict |
| `orders/fulfilled`, `fulfillments/update` | Close contract window; delivery-failure reschedule flow |
| `checkouts/create`, `checkouts/update` | Abandoned checkout candidates (only when the store uses Shopify Checkout — see E-14) |
| `customers/update` | Consent changes → update ledger |
| `app/uninstalled` | Stop everything for the shop within seconds; schedule data purge |
| `app_subscriptions/update` | Billing state changes (declined, cancelled) → pause dispatch |
| `shop/update` | Timezone/currency changes |
| **Mandatory compliance:** `customers/data_request`, `customers/redact`, `shop/redact` | Required for every App Store app; must verify HMAC and return 401 on bad HMAC; act within 30 days; `shop/redact` fires 48h after uninstall `[VERIFIED]` |

Webhook handler rules: verify `X-Shopify-Hmac-Sha256` with the app secret; dedupe on `X-Shopify-Webhook-Id`; respond 200 within 5 s (Shopify retries and eventually removes subscriptions on repeated failure); process asynchronously via Pub/Sub. Reconcile hourly with a GraphQL `orders` query (webhooks are at-least-once, not guaranteed).

### 8.4 Merchant onboarding flow (in-app)

1. Install → OAuth → shop record → welcome screen.
2. **Business details**: legal name, GSTIN, PAN, address, support phone (needed for DLT PE and for the agent to quote a callback number).
3. **Compliance step (India)**: explain TRAI; collect DLT PE ID if they have one, else guided registration link + upload proof; link PE to Naaradh telemarketer; status `pending` blocks promotional use cases but **does not** block transactional COD `[OPEN — depends on CLI answer]`.
4. **Use case selection**: COD confirmation on by default; abandoned cart off until consent capture is enabled.
5. **Script review**: show the default Hinglish/English script with variables; merchant edits allowed within guardrails (no discounts/claims not in their store policy); merchant clicks "Approve" → `scripts` row with version.
6. **Voice & language**: pick from 2–3 curated voices; default locale from store language; per-order locale from shipping address state (e.g., Tamil Nadu → Tamil if engine supports).
7. **Behaviour settings**: auto-cancel on customer "no" (off by default), auto-update address (off), retry policy (default 1 retry after 2h within window), calling hours (locked 9–21 IST for India), max daily spend cap.
8. **Test call** to the merchant's own phone using a sandbox order.
9. **Billing**: choose plan → Shopify Billing API (`appSubscriptionCreate` with `appRecurringPricingDetails` + `appUsagePricingDetails`, `cappedAmount` = merchant spend cap). Handle the `confirmationUrl` redirect and `app_subscriptions/update` webhook.
10. Go live toggle.

### 8.5 Order tagging and write-back conventions `[DECISION]`

- Tags: `naaradh:cod-confirmed`, `naaradh:cod-cancelled`, `naaradh:cod-reschedule`, `naaradh:no-answer`, `naaradh:wrong-number`, `naaradh:opt-out`, `naaradh:address-updated`, `naaradh:transfer-requested`.
- Order note (append): `Naaradh · <ts> · <outcome> · <summary ≤ 200 chars> · recording in app`.
- Metafields (namespace `naaradh`): `cod_status`, `last_call_at`, `attempts`, `confidence`, `outcome_ref` — so Shopify Flow, fulfilment apps, and 3PL integrations can act on them.
- Shopify Flow triggers: publish a custom Flow trigger "Naaradh call completed" so merchants can build "if cancelled → cancel order and notify" without code `[VERIFY Flow trigger extension requirements]`.

### 8.6 Shopify App Store review — requirements checklist `[VERIFIED items from Shopify requirements; VERIFY current list]`

- Embedded, App Bridge, session-token auth; Polaris UI; works on mobile admin.
- OAuth flow correct; installs cleanly on a dev store; no broken links; loads < 3 s.
- Billing via Shopify Billing API only; pricing disclosed on the listing.
- Mandatory compliance webhooks implemented and HMAC-verified.
- Protected customer data Level 2 approval obtained before listing.
- Privacy policy URL, support email, support URL, app listing screenshots and demo video.
- No pop-ups or misleading claims; no data scraping beyond scopes.
- Uninstall cleans up (webhooks are removed automatically; your DB purge on `shop/redact`).
- Review can take 1–4 weeks and often returns with requested changes — budget for two rounds.
- "Built for Shopify" badge (optional later): additional performance and UX criteria.

### 8.7 Testing

- Shopify **development store** with test COD gateway ("manual payment" / Cash on Delivery) and Bogus Gateway.
- Shopify CLI `shopify app dev` tunnels for local; staging deployed on `shopify-stage.naaradh.com` with a separate Partner app.
- Webhook replay tool (store raw payloads in `webhook_events`; re-publish to Pub/Sub).
- Contract tests for every GraphQL query/mutation with the pinned API version; monitor Shopify's deprecation headers.

### 8.8 Indian-checkout reality `[VERIFIED — Cashfree docs; VERIFY GoKwik/Shiprocket/Razorpay Magic specifics]`

Many Indian Shopify stores use **one-click checkout providers** (GoKwik, Shiprocket Checkout, Razorpay Magic, Cashfree OCC) that replace Shopify Checkout. Consequences:

- `checkouts/*` webhooks may **not fire** for abandoned carts; those providers expose their own abandoned-checkout webhooks with phone, partial address, cart, resume URL, and marketing opt-in status.
- Orders still land in Shopify via `orders/create`, so COD confirmation still works. Payment gateway name will reflect the provider — normalise gateway names per provider.
- Build an "abandoned cart source" abstraction: `shopify_checkout | gokwik | shiprocket | razorpay_magic | cashfree | custom_webhook`.
- Some of these providers already offer COD confirmation via WhatsApp/IVR — position Naaradh as conversational confirmation with higher answer/resolution rates, and integrate with their RTO scoring where APIs exist.

---

## 9. Non-Shopify integrations

### 9.1 Public REST API (`api.naaradh.com`) — for Client B and any website

- Auth: per-tenant API key (`nrd_live_...`) as Bearer; keys hashed in DB; scoped (`intents:create`, `intents:read`, `calls:read`, `consents:write`, `suppressions:write`, `webhooks:*`, and for the support line `support:read|write`, `tickets:read|write`, `orders:write`).
- Endpoints (v1):
  - `POST /v1/intents` — create a call intent `{use_case, phone, name?, variables, external_ref, event_ts, consent?: {source, evidence_uri, wording_version}, idempotency_key}` → `202 {intent_id, status}`
  - `GET /v1/intents/{id}` — status + attempts + outcome
  - `POST /v1/intents/{id}/cancel`
  - `POST /v1/consents` — record consent
  - `POST /v1/suppressions` — opt-out a number
  - `GET /v1/calls/{id}/recording` — signed URL, 15 min
  - `POST /v1/webhooks` — register merchant webhook (events: `intent.scheduled`, `call.started`, `call.completed`, `outcome.final`, and for inbound `ticket.created`, `ticket.resolved`, `order.cancellation_requested`, `order.cancelled_by_agent`, `order.confirmed_by_caller`, `inbound.call_refused`), signed with HMAC-SHA256 (`X-Naaradh-Signature`, timestamp, replay window 5 min)
  - Support line (ADR-0006): `GET|POST /v1/inbound-profiles`, `PUT /v1/inbound-profiles/{id}`, `POST /v1/inbound-profiles/{id}/activate|disable` (greeting disclosure re-validated on activation); `GET|POST /v1/knowledge`, `PUT /v1/knowledge/{id}`; `GET|POST /v1/transfer-targets`, `POST /v1/transfer-targets/{id}/verify` (owner/manager attestation, audited), `…/deactivate`; `GET /v1/tickets`, `POST /v1/tickets/{id}/resolve`; `PUT|DELETE /v1/orders/{external_id}` (order cache for non-Shopify merchants; stale updates ignored, DELETE erases)
- Rate limits: 60 req/min per key (burst 120); 429 with `Retry-After`.
- Idempotency: `Idempotency-Key` header; replay returns same 202/200.
- OpenAPI 3.1 spec published at `docs.naaradh.com`; SDK generation for JS/Python later.

### 9.2 Website JS snippet (`cdn.naaradh.com/naaradh.js`)

- Captures form submissions with phone → posts to `/v1/intents` via the merchant's **public site key** (restricted: `intents:create` only, domain-allow-listed, rate-limited).
- Includes a consent checkbox helper with configurable wording; stores wording version and timestamp; sends as `consent` in the intent.
- Never collects more than name/phone/form fields the merchant maps.

### 9.3 WooCommerce plugin (phase 2) `[DECISION]`

- PHP plugin, WordPress.org listing (GPL licence for the plugin code; SaaS backend stays proprietary).
- Hooks: `woocommerce_new_order`, `woocommerce_order_status_changed`, `woocommerce_checkout_update_order_review` (for consent checkbox), custom abandoned-cart capture (Woo has no native abandoned checkout object; capture phone at checkout via AJAX and track cart hash).
- Settings page: API key, use cases, script approval, consent checkbox text.
- WP.org review requirements: no obfuscated code, GPL, privacy disclosure of external calls to `api.naaradh.com`, proper nonces and capability checks, i18n.

### 9.4 CRM / calendar (phase 2–3)

- Zoho CRM (India-heavy), HubSpot, Salesforce: push call outcome as an Activity/Note; read lead phone + consent; trigger lead-callback intents from new leads.
- Cal.com and Google Calendar: slot lookup + booking via engine tool calls; Naaradh stores booking ref.
- Zapier/Make/n8n: expose "New outcome" trigger and "Create intent" action.
- Google Sheets export: nightly per-tenant export (optional).

---

## 10. Agent (script) design

### 10.1 Global rules baked into every agent `[DECISION]`

- First utterance (≤ 6 seconds): greeting + brand + **"This is an automated AI call and it is being recorded"** in the call locale (TRAI auto-dialer disclosure, EU AI Act Art. 50, recording consent). Structured flags `ai_disclosed_at`, `recording_disclosed_at` set when TTS of that segment completes.
- Never ask for or read out: OTPs, card numbers, UPI PINs, Aadhaar, passwords, full addresses beyond confirming pincode/landmark. Refuse and escalate if asked.
- Never offer discounts, delivery dates, or refunds not present in `variables` supplied by the merchant.
- Immediately end the call and mark `opt_out` on phrases like "don't call", "mat karo call", "remove my number", "stop", "unsubscribe" (multilingual pattern list + LLM intent classification).
- Wrong person: ask once to hand over to the customer; if not available in 10 s → polite end, `wrong_number` or `callback_later`.
- Silence handling: 2 prompts, then end (`no_response`).
- Max duration: COD 120 s; abandoned cart 150 s; appointment 240 s.
- Transfer to human: only if merchant configured a transfer number; announce transfer; warm-transfer with a one-line summary if the engine supports it; if transfer fails, take a message and mark `transfer_failed`.
- Language: start in the tenant default; switch on customer cue (Hindi/English/Hinglish); store `detected_locale`.

### 10.2 COD confirmation script (Hinglish default) — structure

1. Disclosure + identify: "Namaste {customer_name}, main {brand} ki taraf se automated AI assistant bol rahi hoon, yeh call record ho rahi hai."
2. Purpose: "Aapne {order_ref} ka order kiya hai, ₹{amount} cash on delivery, {item_summary}. Kya hum ise ship kar dein?"
3. Branches:
   - Yes → confirm pincode/landmark (read back pincode only) → "Dhanyavaad, order {eta_text} tak deliver hoga." → `confirmed`
   - No → ask reason (multiple-choice: changed mind / ordered by mistake / price / found elsewhere / duplicate) → `cancelled` + `cancel_reason`
   - Wants change (qty/address/date) → capture within allowed variables → `confirmed_with_changes` or `needs_merchant_action`
   - Wants prepaid/discount → only if merchant enabled `prepaid_offer` with a link sent by SMS/WhatsApp → `convert_to_prepaid_requested`
   - Asks for human → transfer or callback promise → `transferred` / `callback_requested`
4. Close: opt-out instruction if promotional (not needed for transactional), thank, end.
5. Extraction schema returned to Naaradh: `{outcome, cancel_reason?, pincode_confirmed: bool, address_change?: string, reschedule_date?: string, notes, confidence}`.

### 10.3 Appointment confirm/book script — structure

Disclosure → identify appointment ({service}, {date}, {time}) → confirm / reschedule (tool: `get_slots(date_range)` → offer ≤3 → `book_slot(slot_id)`) / cancel → transfer to manager on request → extraction `{outcome, new_slot?, cancel_reason?}`.

### 10.5 Inbound agent design (ADR-0006)

An inbound caller can ask anything, so the inbound agent is not a branch script; it is a **profile + tools + knowledge**, with the same fixed opening and guardrails as outbound.

- **Opening (fixed, validated):** "Namaste, {brand} mein aapka swagat hai. Main ek automated AI assistant hoon aur yeh call record ho rahi hai. Main aapki kya madad kar sakti hoon?" — disclosure in the first sentence, in the profile locale; `ai_disclosed_at` set when it finishes.
- **Rules baked into every inbound prompt:** identify the need first; never state an order fact that did not come from `lookup_orders`; never state a policy that did not come from `search_knowledge` or a pinned fact; if unsure, say so and offer a ticket; ask for the order number + pincode only when the caller wants something about a specific order and caller ID did not match; never ask for OTPs, card numbers, UPI PIN, Aadhaar, passwords; confirm cancellations twice and read back the order; transfer only via the tool; answer "are you a human?" truthfully; end on opt-out after `register_opt_out`.
- **Pinned facts** (≤ 20 lines) cover what is asked on almost every call (delivery time, COD availability, return window, support hours); the knowledge base covers the long tail.
- **Latency:** a filler line ("ek second, main check karti hoon") is spoken by the engine while a tool runs; tools return in < 700 ms p95 so the filler is rarely needed.
- **Extraction:** `inbound_support_v1` → `resolved | ticket_created | transferred | callback_requested | abandoned | opt_out | spam | inconclusive`, plus category and a short summary for the dashboard.

### 10.4 Versioning and A/B

- Scripts immutable per version; each call references `script_version`.
- A/B at the tenant level (50/50) on wording; measure answer rate, confirm rate, opt-out rate, complaint rate.

---

## 11. Call lifecycle state machine

```
INTENT_CREATED → GATED(reason) | SCHEDULED
SCHEDULED → DISPATCHING → DIALING → RINGING → ANSWERED(human|machine) | NO_ANSWER | BUSY | FAILED(carrier)
ANSWERED(human) → IN_CONVERSATION → (TRANSFERRING → TRANSFERRED | TRANSFER_FAILED) | ENDED
ANSWERED(machine) → AMD_HANGUP | AMD_MESSAGE_LEFT
ENDED → OUTCOME_PENDING → OUTCOME_FINAL(confirmed|cancelled|rescheduled|booked|opt_out|wrong_number|inconclusive|...)
NO_ANSWER|BUSY|AMD_HANGUP|inconclusive → RETRY_SCHEDULED (if attempts < max and inside window) | EXHAUSTED
OUTCOME_FINAL → WRITEBACK_PENDING → WRITEBACK_DONE | WRITEBACK_FAILED(retry, then alert)
Any → CANCELLED (order cancelled, merchant cancel, uninstall, kill switch)

INBOUND (no intent):
ARRIVED → ADMISSION → FALLBACK(forward | closed_message) | ANSWERED
ANSWERED → IN_CONVERSATION ⇄ TOOL_CALL(lookup|verify|search|cancel|ticket|transfer|opt_out)
IN_CONVERSATION → (TRANSFERRING → TRANSFERRED | TRANSFER_FAILED → IN_CONVERSATION) | ENDED
ENDED → OUTCOME_FINAL(resolved|ticket_created|transferred|callback_requested|abandoned|opt_out|spam|inconclusive) → MINUTES_METERED
AGENT_ACTION(cancel) → AWAITING_CONFIRMATION → APPROVED → EXECUTED | FAILED(retry, alert) ; or → TICKET
```

Every transition writes `audit_log`; every terminal state emits a merchant webhook and a billing event if billable.

---

## 12. Edge cases — the exhaustive list

### 12.1 Regulatory / consent

- **E-01** Order placed at 20:50 IST: 30-minute transactional window ends 21:20 but calling window closes 21:00 → dispatch immediately (by 20:55) or not at all; never call after 21:00; mark `gated:window` and notify merchant to confirm manually.
- **E-02** Order placed at 22:30: outside window and cannot be transactional by 09:00 next day (30-min rule) → either (a) skip, (b) send WhatsApp/SMS instead (needs template), or (c) treat next-morning call as *service* call requiring the full consent stack `[OPEN — CLI answer]`. Default: (a) skip + merchant notified. Make this a tenant setting once legal opinion exists.
- **E-03** Customer opted out on a previous order → suppression hit → no call, even for a new order; merchant sees reason; 90-day expiry then re-eligible.
- **E-04** Customer on DND → transactional COD may still be allowed `[VERIFY with TSP]`; promotional abandoned-cart never.
- **E-05** 5 complaints in 10 days across all merchants → global kill switch + legal review; per-merchant auto-pause at 3.
- **E-06** Merchant PE registration expires or de-links → pause promotional; flag transactional depending on CLI decision.
- **E-07** Recipient region ≠ merchant region (Indian merchant, US customer number): apply recipient rules (TCPA), require US consent record, use US CLI, else gate.
- **E-08** Consent evidence missing but merchant asserts "we have it" → require upload of evidence or a signed attestation in-app; log attestation; still no promotional call until evidence exists `[DECISION]`.
- **E-09** Customer asks "are you a human?" → must answer truthfully: AI.
- **E-10** Customer requests data deletion during the call → mark `erasure_requested`; workflow completes within DPDP timelines; recording retained only as required for the request record `[LEGAL]`.
- **E-11** Minor answers the phone → end call politely, no data captured, `minor_answered` suppression for 90 days.
- **E-12** Recording refused ("don't record") → stop recording if engine supports mid-call toggle, else end call and mark `recording_refused`; merchant may follow up manually.
- **E-13** Shopify has no voice-consent object → for promotional calls, capture consent via a checkout UI extension checkbox with custom wording ("…calls, SMS and WhatsApp…") stored as an order attribute + consent ledger; do **not** rely solely on `sms_marketing_consent` `[LEGAL — wording]`.
- **E-14** Store uses GoKwik/Shiprocket/Magic checkout → no `checkouts/*` webhooks; ingest provider webhooks instead; consent flag comes from provider payload.

### 12.2 Telephony / engine

- **E-20** Engine down or 5xx → circuit breaker; intents stay `SCHEDULED`; alert; auto-fail over to secondary engine only for tenants flagged `multi_engine_ok`.
- **E-21** Engine webhook never arrives → `fetchCall` poll after `maxDuration + 60 s`; reconcile job every 5 min for `DIALING/IN_CONVERSATION` older than 10 min.
- **E-22** Duplicate webhooks → idempotent on `external_event_id`.
- **E-23** Unsigned engine webhooks → never trust payload; re-fetch by ID before outcome/billing.
- **E-24** Answering machine detection wrong (human treated as machine) → tune; allow "continue" mode for COD where cost of false AMD is high; measure `amd_false_positive_rate` via transcripts.
- **E-25** Call answered but 0 s speech (pocket answer) → `inconclusive`, non-billable, retry once.
- **E-26** Carrier fails with "invalid number" → validate E.164 + Indian mobile prefix rules (starts with 6–9, 10 digits) before dispatch; `wrong_number` suppression for that order only.
- **E-27** Number ported/landline → engine returns reason; no retry.
- **E-28** CLI blocked/spam-flagged by carriers → rotate within pool; monitor answer rate per CLI; retire CLIs with answer rate < 25% `[DECISION]`.
- **E-29** Concurrency limit reached → queue with priority (COD > appointment > abandoned cart); never drop silently.
- **E-30** Transfer target busy/no answer → return to AI; offer callback; `transfer_failed`.
- **E-31** Customer switches language mid-call → engine supports code-switch or agent responds in detected language; log.
- **E-32** Cost spike (long calls, loops) → per-call `maxDurationSec`; per-tenant daily spend cap; per-engine daily cap.
- **E-33** Vendor price change → `cost_paise_engine` recorded per call from vendor CDR; margin dashboard alerts if GM < 40%.
- **E-34** Recording URL expires → download to GCS within 10 min of `call.ended`; never link vendor URLs in dashboard.

### 12.3 Commerce / data

- **E-40** Order cancelled by merchant while call is ringing → cancel if engine supports; else let it finish and mark `outcome_superseded`, non-billable.
- **E-41** Customer confirms on call, then cancels in Shopify → keep `confirmed` outcome (billable), add tag `naaradh:cancelled-after-confirm` for analytics.
- **E-42** Multiple orders from same phone within 30 min → merge into one call with multiple order refs; one billable outcome per order only if each resolved `[DECISION]`.
- **E-43** Phone missing on order (email-only checkout) → gate `no_phone`; suggest merchant enable phone at checkout.
- **E-44** Address change captured but low confidence → never auto-write; tag `naaradh:address-review` and show suggested change in dashboard.
- **E-45** Prepaid order accidentally routed (gateway mismatch) → gateway normalisation table per provider; skip if not COD.
- **E-46** Test orders / staff orders → skip if `test=true` or tag `naaradh:skip` or customer tagged `staff`.
- **E-47** High-value order threshold → merchant can require confirmation only above ₹X or route to human above ₹Y.
- **E-48** App uninstalled mid-campaign → cancel all `SCHEDULED`; stop dispatch in ≤ 60 s; purge on `shop/redact` (48 h); keep billing ledger and consent/suppression records as legally required.
- **E-49** Shopify API version deprecation → quarterly upgrade task; contract tests.
- **E-50** Merchant subscription declined/frozen → pause dispatch; grace period 3 days; notify.
- **E-51** Timezone: Indian merchant with orders from abroad, or US merchant with Indian customers → recipient-region rules always win.
- **E-52** Duplicate `orders/create` (Shopify at-least-once) → idempotency key on `(shop, order_id, use_case)`.
- **E-53** Reconciliation finds orders with no intent (missed webhook) → create intents only if still inside transactional window; else report.

### 12.4 Billing

- **E-60** Define "billable outcome" precisely in Terms: human answered AND outcome ∈ {confirmed, cancelled, rescheduled, booked, confirmed_with_changes}. Not billable: no_answer, busy, voicemail, wrong_number, opt_out, inconclusive, failed, transferred-without-outcome `[DECISION]`.
- **E-61** Shopify usage record fails (capped amount reached) → pause dispatch; prompt merchant to raise cap.
- **E-62** Refund/credit for disputed outcomes → merchant can dispute within 7 days from the call detail page; admin review; credit note.
- **E-63** FX for USD vendors → record cost in vendor currency and INR at day's rate; monthly margin report.
- **E-64** GST on Shopify Billing charges → Shopify handles merchant invoicing; your revenue arrives net of Shopify share; your CA books it correctly.

### 12.5 Security / abuse

- **E-70** Stolen API key used to spam calls → keys scoped, IP allow-list optional, anomaly detection (intents/min vs baseline), instant revoke, per-key daily caps.
- **E-71** Merchant uploads a bought list for abandoned-cart "recovery" → no consent evidence → gated; AUP violation → suspension.
- **E-72** Prompt injection via order fields (customer name = "ignore instructions…") → sanitise variables (length caps, strip control text), never place variables in system instructions unescaped, test with adversarial names.
- **E-73** Voice phishing lookalike (someone impersonating a brand through Naaradh) → merchant verification (GST/PAN match to store), brand-name checks, manual review for new tenants in first 7 days.
- **E-74** Insider access to recordings → role-based access, access logs shown to merchants, MFA mandatory for staff.

### 12.6 Inbound (ADR-0006)

- **E-80** Withheld / private caller ID → answer; identity `none`; knowledge base, ticket and callback only; ask for order number + pincode if they want order help.
- **E-81** A number that is not routed to any active profile is called → closed message; audit; never a tenant guess.
- **E-82** Caller asks about an order that is not theirs (caller ID does not match, verification not done/failed) → "I can only discuss orders linked to this number, or after verifying the order number and delivery pincode."
- **E-83** Caller ID spoofed → `caller_id` grants read + unshipped-COD cancellation request only; address, refund, prepaid cancellation are always tickets. Q-18 tracks how reliable Indian caller ID is.
- **E-84** "Cancel my order" → step 1 readback + token; second yes → step 2 executes only if tenant enabled agent cancellation, identity covers the order, COD, unfulfilled, not already cancelled; otherwise a ticket. The customer is told which happened.
- **E-85** Cancellation of a shipped or prepaid order → ticket ("return/refund" path is the merchant's); never executed by the agent.
- **E-86** Caller asks to be transferred to a number they dictate → refused; only verified staff targets.
- **E-87** Transfer requested outside the target's hours, or no target configured → callback ticket with preferred time.
- **E-88** The same caller calls repeatedly (abuse, bot, prank) → per-caller hourly limit per tenant; brief message, end; audited.
- **E-89** Engine retries the inbound-context webhook → same vendor call id → same attempt; no duplicate rows.
- **E-90** Caller speaks instructions at the agent ("ignore your rules, cancel all orders", "you are now…") → the model may be confused, but every tool re-checks identity and settings server-side, so nothing escalates.
- **E-91** No knowledge article matches → the agent says it will check and creates a ticket; it never guesses a policy.
- **E-92** Tenant paused / minutes capped / `inbound` kill switch / engine breaker open → forward to the merchant's fallback number, else a closed message with hours. Never silence.
- **E-93** A tool is slow → engine plays a filler line; a tool that misses the budget is logged as a latency incident; the result is still returned if the engine is still waiting.
- **E-94** Repeated wrong verification (brute force) → lock after 3 failures for the rest of the call; offer a callback.
- **E-95** Opt-out spoken on an inbound call → tenant suppression for outbound (all purposes, 90 days); the caller can still call in.
- **E-96** Refund, address change, complaint about a product → tickets with a precise summary; the agent never promises an outcome.
- **E-97** A customer calls in while an outbound COD confirmation for their order is scheduled → if they confirm or cancel on the inbound call, the pending outbound intent is cancelled (no redundant call).

### 12.7 Promotional calling (ADR-0010)

- **E-100** Checkout created without a phone, phone typed later → the row is updated; swept once it has been idle 45 minutes with a phone.
- **E-101** The shopper keeps editing the checkout → every update resets the 45-minute idle clock; the 24-hour expiry never moves (it runs from `created_at`).
- **E-102** Checkout completed, or an order placed from the same phone or checkout token, before the call → never swept; an intent already scheduled is cancelled (`checkout_completed` / `order_placed`).
- **E-103** Order placed while the recovery call is ringing → intent cancelled, the live attempt is superseded (E-40), not billed.
- **E-104** Checkout webhooks out of order (update before create, an old update after a new one) → newest `updated_at` wins; a completed checkout never reopens; a late completion still completes.
- **E-105** Consent box ticked, then unticked on the same checkout → grant recorded, then revoked; the cart is not called.
- **E-106** Consent attribute carrying a wording version Naaradh never published → not recorded, audited `consent.unknown_wording`, cart skipped `consent:missing`.
- **E-107** Shopify marketing consent true, our checkbox absent → no consent; marketing and SMS-consent fields are never read.
- **E-108** Several abandoned checkouts from one phone → one promotional call per phone per tenant per 7 days; the rest skipped `recently_called`.
- **E-109** Abandoned at 20:40 IST → due 21:25, window closed → waits for 09:00 if still inside the 24-hour deadline, else expires.
- **E-110** Checkout already older than 24 hours when first seen (late webhook, reinstall) → never swept; `expired`.
- **E-111** Store on a one-click checkout (GoKwik, Shiprocket, Magic — E-14) → no `checkouts/*` webhooks; nothing to sweep; the Results page shows zero checkouts.
- **E-112** Promotional script without a registered DLT content template id → `script:dlt_template_missing`; the use case cannot even be switched on.
- **E-113** Complaint attributed to a promotional call → that tenant's promotional calling is paused at once (`tenant:promotional_paused`); transactional and inbound continue; only staff lift it; the E-05 counters are unchanged.
- **E-114** Delivered event for a cancelled, refunded, returned or test order → no feedback call.
- **E-115** Duplicate delivered events → one feedback intent (idempotency on source, order and use case).
- **E-116** A/B arm retired mid-test → the remaining arm serves every call; attempts keep the script id they ran; approving another version during a test is refused.
- **E-117** Order after a promotional call that never reached a human (no answer, voicemail) → not attributed.
- **E-118** Attributed order cancelled later → attribution reversed; revenue excluded from the Results page.
- **E-119** Erasure / `shop/redact` / retention → checkout rows lose the phone hash, contact link and cart summary; counts stay.

### 12.8 Non-Shopify sources and appointments (ADR-0011)

- **E-120** A platform posts a cart with no phone, then adds one → same as E-100: updated, swept once idle with a phone.
- **E-121** A platform posts a cart the shopper never consented to → recorded for the funnel, never called (`consent:missing`).
- **E-122** A platform posts carts in a loop (bad cron, retry storm) → idempotent on (tenant, source, ref); the per-key daily cap and the 7-day promotional cooldown bound the damage.
- **E-123** Order placed for a cart Naaradh was about to call → `POST /v1/carts/{ref}/completed` closes it; a queued intent is cancelled and a ringing call superseded (E-102, E-103).
- **E-124** The merchant's site is offline when a result is sent → retried with backoff, dead-lettered after 5, visible in Developers → webhook health.
- **E-125** Someone forges a result to the WooCommerce plugin's REST route → HMAC and timestamp verified before the body is parsed; a bad one is 401 and logged, never an order note.
- **E-126** The plugin's API key is revoked or wrong → calls fail closed, an admin notice appears, orders still work.
- **E-127** WooCommerce checkout with the phone field hidden → nothing is sent; the settings page says why.
- **E-128** A merchant rewords the consent text in their theme → the ledger records the VERSION Naaradh published; reworded text is an AUP breach, and the evidence still says which text Naaradh stands behind.
- **E-129** Calendar provider unreachable during a call → `get_slots` returns nothing and the agent offers a callback; it never invents a time.
- **E-130** Two callers take the same slot → the provider is the arbiter; the loser hears "that time has just gone" and is offered the current list.
- **E-131** Caller asks to book for someone else's number → refused; appointments are booked only against the number the call is on. Anything else is a ticket.
- **E-132** A slot id the call was never offered (a model "remembering" a time) → refused; the agent re-reads the calendar.
- **E-133** Appointment moved or cancelled after a reminder was queued → the queued call is cancelled (`appointment_moved` / `appointment_cancelled`) and the sweep decides again from the new time.
- **E-134** Appointment created less than 2 hours before it starts → no reminder call; the row is marked decided so it is not reconsidered for ever.
- **E-135** Reminder due outside the calling window → window rules win (invariant 3): it waits for 09:00 and is placed only if that is still at least 2 hours before.
- **E-136** Caller asks a clinical question on an appointment call → never answered; a ticket or a transfer. The shipped appointment scripts forbid diagnosis, prescriptions and test results.
- **E-137** Appointment for a number that opted out → suppression is absolute (invariant 6): no reminder call; the appointment itself is untouched.
- **E-138** A CRM or automation tool creates a lead-callback intent with no consent → allowed as a service purpose (the customer asked to be called), refused for anything promotional.
- **E-139** Two platforms report the same cart → one row per (tenant, source, ref); the 7-day per-phone cooldown means one call at most.

### 12.9 Regional isolation (ADR-0012)

- **E-142** A tenant whose `data_region` is not this deployment's → every outbound call refused `tenant:other_region`; inbound not answered here (the caller is forwarded, never dead air); cross-tenant sweeps skip the tenant entirely.
- **E-143** A US or EU store installs the Shopify app while only the India deployment exists → it installs and is waitlisted (Q-20); the tenant is created with its own `data_region` and nothing can call it.
- **E-144** A webhook for a shop in another region reaches this deployment → verified and acknowledged, acted on only if the tenant is in region; otherwise audited and ignored, never silently dropped.
- **E-145** Staff open a tenant from another region in the console → the console is per region; that tenant is not in this database.
- **E-146** `DATA_REGION` misconfigured → every tenant is out of region, so the first dispatch fails loudly rather than writing foreign data.

---

## 13. Legal documents to prepare `[LEGAL — drafts, then lawyer]`

| Document | Key clauses specific to Naaradh |
|---|---|
| **Terms of Service (merchant)** | Merchant is Principal Entity / sender; merchant warrants lawful basis and consent for every number; Naaradh acts as telemarketer/processor on instructions; definition of billable outcome; spend caps; suspension on complaints; no BFSI/collections/political/adult/gambling use; script approval responsibility; limitation of liability; indemnity for consent failures; governing law (India, courts at Delhi/Ghaziabad `[DECISION]`); arbitration clause |
| **Acceptable Use Policy** | Prohibited: purchased lists, non-consented marketing, deceptive scripts, emergency/premium numbers, calls outside windows, impersonation, regulated sectors (lending/collections/insurance/securities/health advice), political campaigning |
| **Privacy Policy (naaradh.com + app listing)** | Categories of data (call recordings, transcripts, phone, name, order details), purposes, retention, sub-processors (GCP, engine vendor, telephony provider, payment providers), rights and grievance officer contact (DPDP), international transfers (US/EU tenants) |
| **Data Processing Agreement** | DPDP + GDPR Art. 28 terms; sub-processor list with notice of changes; security measures annex; breach notification timelines; audit rights; deletion on termination; India residency default |
| **Consent wording templates** | Checkout checkbox text (calls/SMS/WhatsApp), website form text, verbal consent phrasing, AI + recording disclosure lines per language |
| **Merchant compliance attestation** | Clickwrap at onboarding: TRAI obligations acknowledged; PE registration; script truthfulness; complaint cooperation |
| **Promotional calling addendum** | Draft in `docs/legal/promotional-terms-addendum.md` (ADR-0010): what the promotional use cases do and their built-in limits; merchant warranties on the consent box, no purchased lists, its own DLT templates; Naaradh sends no SMS/WhatsApp; **a recovered cart is not billable** and attribution is measurement only; promotional-only suspension on a promotional complaint; checkout data and its 30-day phone retention |
| **SLA (Scale/Enterprise)** | Availability 99.5–99.9%, support response times, service credits; exclusions for engine/carrier outages |
| **Sub-processor list page** | Public, dated |
| **Cookie notice** | Marketing site + dashboard |
| **Refund policy** | Outcome disputes; platform fee non-refundable after 14 days |
| **Employee/contractor NDA + data-handling policy** | Required for Shopify Level 2 and DPDP |
| **Incident response plan** | Required for Shopify Level 2; include DPDP breach notification steps |
| **Trademark filing** | "Naaradh" word mark + logo |
| **Shopify Partner Program Agreement / App Store terms** | Read the revenue share, data rules, and listing rules before building billing |
| **WordPress.org plugin guidelines** | GPL, no phoning home without disclosure |

---

## 14. Security and compliance checklist (pre-launch)

- [ ] MFA enforced for all staff GCP/GitHub/Shopify Partner/registrar accounts
- [ ] No long-lived service-account keys; Workload Identity Federation for CI
- [ ] Cloud SQL private IP + SSL + PITR + HA; Redis private IP
- [ ] CMEK on recordings bucket; bucket-level uniform access; no public buckets
- [ ] Secrets in Secret Manager; rotation runbook
- [ ] HMAC verification on every inbound webhook; 401 on failure; replay window
- [ ] RLS on all tenant tables; integration test that proves cross-tenant reads fail
- [ ] Phone numbers hashed for lookup, encrypted for dial; never in logs
- [ ] Log exclusions for PII; recording URLs never logged
- [ ] Cloud Armor WAF + rate limits; per-key API limits
- [ ] Dependency scanning (Dependabot), container scanning (Artifact Registry), SAST in CI
- [ ] Backups tested by restore drill; DR runbook written
- [ ] Data retention jobs running; deletion verified end-to-end (recording, transcript, ledger, BQ)
- [ ] `security.txt`, vulnerability disclosure page
- [ ] Access review process (quarterly)
- [ ] Incident response plan + on-call rota (even if it's one person)
- [ ] Privacy policy, DPA, AUP, ToS published and versioned
- [ ] Shopify Level 2 protected data approval granted
- [ ] DLT telemarketer registration active; PE linkage flow working
- [ ] TSP written confirmation of CLI series for service calls on file `[OPEN]`
- [ ] Do-not-call self-service page live and tested
- [ ] Complaint counters and auto-pause tested with synthetic complaints
- [ ] AI + recording disclosure verified in every language script and logged per call
- [ ] Calling-window enforcement tested at boundaries (08:59, 09:00, 20:59, 21:00 IST)
- [ ] Spend caps tested (tenant, engine, global)
- [ ] Kill switches tested (global, tenant, campaign, engine)
- [ ] Load test: 500 webhooks in 60 s; 50 concurrent calls in staging with engine simulator

---

## 15. Testing and the engine bake-off protocol

### 15.1 Bake-off (do this before any product code)

- Same script, same 20 scenarios, 2–3 engines, real Indian mobiles on Jio/Airtel/Vi 4G, indoor and outdoor.
- Scenarios: clear yes; clear no; "kaun bol raha hai?"; asks for human; wrong person; child answers; background noise; Hindi only; English only; Hinglish switch mid-sentence; interrupts constantly; long silence; asks to change address; asks for discount; asks "are you a robot?"; asks to stop calling; voicemail; busy; number off; regional accent (Bihari/Punjabi/Tamil-accented Hindi).
- Score per call: answered-by detection correct (Y/N), first-response latency (ms, stopwatch on recording), understood intent (1–5), naturalness (1–5), correct extraction (Y/N), disclosure spoken (Y/N), cost per call (from vendor invoice, verify per-second billing).
- Output: a table + recordings. Pick the winner on **extraction accuracy and answer-rate on real numbers**, not on demo-page latency.

### 15.2 Automated testing

- Unit: gate logic (windows, consent age, suppression), idempotency, outcome mapping, billing computation.
- Integration: Shopify webhook → intent → dispatcher → engine simulator → results → tag write-back → usage record (all in Docker/Testcontainers).
- Contract tests per engine adapter using recorded vendor payloads.
- Load: k6 on `hooks` and dispatcher.
- Chaos: kill engine simulator mid-call; delay webhooks; duplicate webhooks; DB failover.
- Compliance regression suite: a fixed set of intents that must be gated (outside window, opted out, no consent, DND, over cap).

---

## 16. Launch plan and timeline `[DECISION — assumes 1–2 engineers + you]`

| Week | Milestone |
|---|---|
| 0 | Pvt Ltd filing started; TSP emails sent (Appendix A); engine bake-off; Client A RTO baseline pulled (Appendix C); domain DNS on Cloud DNS; GCP org + projects + billing; Terraform skeleton |
| 1–2 | Core DB, `hooks`, `dispatcher`, `results`, engine adapter for winner; engine simulator; Client B via API (lead callback) live in pilot mode |
| 3–4 | Shopify app (OAuth, `orders/create`, tags/notes, dashboard MVP, Billing API); Client A COD live in pilot on a dev-store mirror then production; DLT telemarketer application submitted |
| 5–6 | Consent ledger + suppression + DNC page + complaint counters; script versioning; recordings to GCS; RTO dashboard; Level 2 protected-data request submitted |
| 7–8 | Hardening (§14 checklist), load tests, runbooks; legal docs finalised; App Store listing submitted |
| 9–12 | Review iterations; 5–10 merchants onboarded via direct outreach; pricing validated; abandoned-cart with consent checkbox (checkout UI extension) |
| 13–20 | WooCommerce plugin; Zoho/HubSpot; Cal.com appointment flow; case study published |
| 20+ | US/EU project spin-up with Retell adapter; DPIA; EU opt-in flow; separate GCP projects |

Kill criteria at week 2: bake-off extraction accuracy < 85% on real numbers, or per-minute rounding with no per-second option at all vendors, or TSP responses make non-BFSI service calls impossible on any compliant CLI → pause and rethink vertical.

---

## 17. Tools and accounts inventory

| Category | Tool | Purpose |
|---|---|---|
| Source | GitHub (org: naaradh) | Code, issues, Dependabot |
| Cloud | Google Cloud (org + 4 projects) | Everything in §6 |
| IaC | Terraform ≥ 1.9, `google` provider | Infra |
| Runtime | Node.js 22 LTS, TypeScript 5.x, Fastify 5 + Zod; Next.js 15 for dashboard; React Router for the Shopify app (ADR-0007); Drizzle ORM | App |
| DB | Cloud SQL Postgres 16; Redis 7 (Memorystore) | State, queues |
| Queues | Pub/Sub, Cloud Tasks, Cloud Scheduler | Async |
| Shopify | Partner account, dev stores, Shopify CLI 3.x, App Bridge, Polaris, `@shopify/shopify-api` | App |
| Voice | Bolna / OmniDim (API), Retell (US/EU) | Engine |
| Telephony | Exotel or Plivo (India); Twilio/Telnyx (US); via engine or SIP | Numbers |
| Payments | Razorpay (INR), Stripe (USD), Shopify Billing | Billing |
| Email | Google Workspace; Postmark/Resend | Team + transactional |
| Docs | Mintlify or Docusaurus; OpenAPI 3.1 | Developer docs |
| Support | Crisp / Intercom / plain email + Linear | Merchant support |
| Monitoring | Cloud Monitoring, Error Reporting, Sentry (optional), Better Stack status page | Ops |
| Analytics | BigQuery + Looker Studio; PostHog for product analytics `[DECISION]` | Insight |
| Security | Cloud Armor, Secret Manager, KMS, Dependabot, Trivy in CI | Security |
| Legal | Lawyer (TMT/telecom + data), CA (GST/FEMA), trademark attorney | Compliance |
| Testing | Vitest/Jest, Testcontainers, k6, Playwright | QA |
| Design | Figma; Polaris kit | UI |

---

## 18. Open questions — do not guess, get answers on record

1. **CLI series for non-BFSI service calls (COD confirmation)** — written TSP answers (Airtel/Jio/Vi enterprise + Exotel + Plivo). `[OPEN]`
2. **Is DND scrubbing required for transactional calls** or only promotional? `[OPEN]`
3. **Is DCA (Digital Consent Acquisition) required for voice consent** or SMS only? `[OPEN]`
4. **Per-second billing and minimum duration** at Bolna, OmniDim, Retell. `[OPEN]`
5. **Which vendor is telemarketer-of-record** when using their +91 numbers. `[OPEN]`
6. **DPDP Rules final timelines** for breach notification and erasure. `[LEGAL]`
7. **Shopify policy on apps updating customer marketing consent** based on verbal opt-out. `[VERIFY]`
8. **Whether Shopify allows voice-call consent wording on the SMS checkbox** vs requiring a separate checkbox via checkout UI extension. `[VERIFY + LEGAL]`
9. **GoKwik / Shiprocket / Razorpay Magic webhook access** for abandoned carts — partner programs or merchant-level keys? `[OPEN]`
10. **Exact Level 2 protected-data review lead time** in 2026. `[VERIFY]`
11. **Export-of-services GST treatment** for Shopify App Store payouts. `[CA]`
12. **Two-party recording consent** list for US states, current. `[VERIFY]`
13. **Inbound in India (Q-15):** DLT/TCCCPR treatment of an AI answering a 10-digit virtual number, and of the transfer leg to merchant staff. `[OPEN]`
14. **Inbound pricing (Q-17):** per-minute price book in §2.2 is a starting point. `[DECISION — founder]`
15. **Caller-ID reliability on Indian networks (Q-18):** how often it is withheld or spoofable in practice — decides how much `caller_id` may unlock. `[VERIFY in pilot]`

---

## Appendix A — Email to TSPs / CPaaS (send this week)

> **Subject:** CLI provisioning and DLT compliance for AI-driven service calls — non-BFSI e-commerce
>
> We are Naaradh (Pvt Ltd incorporation in progress), building an AI voice platform that places short **transactional/service calls** on behalf of e-commerce merchants — specifically cash-on-delivery order confirmation calls placed within 30 minutes of order placement — and, separately, **promotional** calls (abandoned checkout follow-up) with explicit customer consent.
>
> Please confirm in writing:
> 1. For a **non-BFSI** Principal Entity making **service/transactional** calls through an AI auto-dialer, which CLI series do you provision (140xxxxxxx, 1600/1601xxxxxxx, or a standard 10-digit number)? Please cite the TRAI/DoT basis.
> 2. For **promotional** calls by the same PE, confirm 140-series provisioning, the template registration process, and whether NCPR/DND scrubbing is performed by you at dial time or must be performed by us.
> 3. Whether NCPR scrubbing is required for transactional calls under your policy.
> 4. Your process for registering us as a **Telemarketer (Aggregator)** on your DLT platform and linking merchant PEs to us, including fees and timelines.
> 5. Whether your platform supports SIP trunking to a third-party AI voice engine, and per-second billing for outbound calls.
> 6. Complaint handling: how complaints are attributed (to the PE, the telemarketer, or the CLI) and your suspension policy.
>
> We intend to operate fully within TCCCPR and would like your written guidance on file before provisioning. Happy to share our compliance design.

Send to at least three providers; keep replies in `legal/tsp-responses/`.

## Appendix B — Vendor bake-off scoring sheet (columns)

`vendor | scenario_id | network | answered_by_detected | answered_by_actual | first_response_ms | intent_understood_1to5 | naturalness_1to5 | extraction_correct | disclosure_spoken | duration_sec | billed_sec | cost_inr | notes | recording_uri`

## Appendix C — Client A RTO baseline (pull before anything else)

From Shopify (GraphQL `orders` with `financial_status`, `fulfillment_status`, `payment_gateway_names`, `cancel_reason`, `tags`, `shipping_address.province`) for the last 90 days:

- COD orders count; COD share of all orders
- RTO count (orders returned-to-origin / delivery failed — from 3PL tags or fulfilment events) and RTO %
- Average order value (COD) and average RTO cost (forward + return shipping + handling) — get shipping invoices from the merchant
- Current confirmation method (none / WhatsApp / IVR / human), and its cost per order
- Result: **monthly RTO loss in ₹** and **RTO % by state/pincode band**. This is the number you sell with and the baseline you must beat within 30 days.

## Appendix D — Glossary

TCCCPR (TRAI regulation on commercial communication) · DLT (Distributed Ledger Technology platform for sender/telemarketer registration) · PE (Principal Entity) · RTM (Registered Telemarketer) · NCPR/DND (do-not-disturb registry) · CLI (Calling Line Identity) · DCA (Digital Consent Acquisition) · DPDP (Digital Personal Data Protection Act 2023) · RTO (Return to Origin) · COD (Cash on Delivery) · AMD (Answering Machine Detection) · CMEK (Customer-Managed Encryption Keys) · RLS (Row-Level Security) · PCD (Protected Customer Data, Shopify) · TCPA (US Telephone Consumer Protection Act) · ePrivacy (EU Directive 2002/58/EC) · PECR (UK Privacy and Electronic Communications Regulations)

---

## Document history

| Version | Date | Change |
|---|---|---|
| 1.5 | 19 Sep 2026 | **Regional isolation (ADR-0012, PLAN Phase 6 groundwork):** §12.9 adds E-142–E-146. One deployment serves one region (`DATA_REGION`): the gate refuses `tenant:other_region`, inbound admission refuses `inbound:other_region` with a forward, and every cross-tenant sweep filters on `tenants.data_region`. A tenant's region is set once at provisioning and never changes. Nothing changes for the India deployment, where every tenant is `in`. |
| 1.4 | 16 Sep 2026 | **Non-Shopify sources and appointments (ADR-0011, PLAN Phase 5):** §12.8 adds edge cases E-120–E-139. One ingestion contract for carts (`PUT /v1/carts/{ref}`) instead of a parser per platform — WooCommerce, one-click checkouts and bespoke stores all use it, under the same promotional rules as ADR-0010. Appointments get a calendar port (Cal.com adapter `[VERIFY]`), two agent tools (`get_slots`, `book_slot`) that can only offer times the provider returned, and one confirmation call per appointment inside the existing −24 h/−2 h envelope. The billable set (§2.2, E-60) is unchanged: `booked` was already in it. New open questions Q-25–Q-27. |
| 1.3 | 16 Sep 2026 | **Promotional calling (ADR-0010, PLAN Phase 4):** §12.7 adds edge cases E-100–E-119 (abandoned checkout, consent checkbox, feedback, A/B, recovery attribution, promotional pause, erasure). No change to the billable outcome set (§2.2, E-60): a recovered cart is **measured, not billed** until Q-24 is decided. New open questions Q-21–Q-24. The outcome enum gains `will_complete`, `will_buy_later`, `not_interested`, `price_objection`, `qualified`, `feedback_given` — none of them billable. |
| 1.0 | 11 Sep 2026 | Initial specification. |
| 1.2 | 12 Sep 2026 | **Product direction change (ADR-0006):** Naaradh becomes a two-way AI voice agent with **inbound support as the lead product**; outbound use cases unchanged. §1 rewritten; §1.2 no longer excludes inbound; §2.2 adds an inbound per-minute price book (`[DECISION — founder to confirm]`, Q-17); §4.4 adds universal rules 11–13; §6.3 adds the `voice` service; §6.5 adds inbound tables; §6.6 adds the inbound flow; §7.1 adds `voice.naaradh.com`; §10.5 inbound agent design; §11 inbound states; §12.6 edge cases E-80–E-97; §18 adds Q-15, Q-17, Q-18. Database is Neon (ADR-0004); outbound dispatch is a Postgres queue (ADR-0005). |
| 1.1 | 11 Sep 2026 | Four internal-consistency corrections, no new decisions: (a) moved this file to `docs/` so the paths in `CLAUDE.md`, `AGENTS.md` and `PLAN.md` resolve; (b) §4.1.1 complaint thresholds corrected to tenant-pause **3** / global-kill **5**, matching E-05 and `AGENTS.md §6` (previously said kill at 4); (c) §6.5 `outcome_enum` expanded to cover every outcome named in prose (`confirmed_with_changes`, `outcome_superseded`, `callback_requested`, `minor_answered`, `recording_refused`, `no_response`, `transfer_failed`, `needs_merchant_action`, `convert_to_prepaid_requested`) and grouped by billability — the **billable set of E-60 is unchanged**; §2.2 aligned to it; (d) §6.3 and §17 corrected from NestJS to Fastify 5, and Prisma/Drizzle to Drizzle, matching `AGENTS.md §2.4`. |

---

*This specification is an engineering and business planning document, not legal advice. Every `[LEGAL]`, `[VERIFY]` and `[OPEN]` item must be closed with a qualified professional or a primary source before the corresponding component goes to production.*
