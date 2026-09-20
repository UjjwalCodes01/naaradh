# Naaradh — what is built, what is left

**Date:** 19 September 2026 · **Audience:** the founder, and anyone you hand this to.
**One document, honest by design.** Detail lives elsewhere (§9); this is the whole picture.

Two words are used strictly:

- **Built** — the code is written, reviewed and tested on this machine against a *simulated*
  voice engine and a real Postgres and Redis. It has never handled a real phone call.
- **Live** — a real customer's phone rings. **Nothing is live.** Every remaining blocker is an
  account, a registration, a vendor contract or a lawyer's opinion, not code.
ujp
---

## 1. The short version

The product is finished to the point where the only thing between it and a real call is
paperwork and vendors. Phases 1 to 5 are code-complete, and Phase 6 (the US and Europe) is built
but not live — Phase 0 (choosing the Indian voice vendor) and Phase 7 are not started. What is built: the AI support line, the
cash-on-delivery confirmation calls, abandoned-cart recovery, post-delivery feedback,
appointments, the merchant dashboard, the Shopify app, the WooCommerce plugin, billing, the
staff console, and the compliance layer that decides whether any given call is allowed.

What is missing, in the order it blocks things:

1. **Voice vendor accounts.** The adapters for Bolna, OmniDimension (India) and Retell (US/EU)
   are all built from the vendors' published APIs, but none has placed a real call: each needs
   its account linked and a handful of verification calls, and the side-by-side test still
   decides which Indian engine is primary. Only Bolna can run the support line, and that part
   stays switched off until it has been seen working (Q-34).
2. **A company, phone numbers and DLT registration.** Indian telecom rules require a registered
   entity and a registered telemarketer before a single number can be bought.
3. **Cloud infrastructure switched on.** The infrastructure is written as code and validated;
   nothing has been applied to Google Cloud, because that spends money and needs the company.
4. **A do-not-disturb screening provider.** Until one is contracted, every promotional call is
   refused by design. Order-confirmation calls are unaffected.
5. **A lawyer's pass** on the consent wording, the legal pages and the US/EU rules.

The strongest thing in the build is the part that says *no*. Every outbound call goes through
one gate with thirteen ordered checks, every inbound call through an admission check, and both
are covered by a regression suite that fails the build if a rule is weakened.

---

## 2. What the product does today

| Surface | What a customer or merchant experiences |
|---|---|
| **Support line (inbound)** | A customer calls the merchant's number. The AI answers, says it is an AI and that the call is recorded, finds *that caller's* orders, answers delivery and policy questions from the merchant's own knowledge base, cancels an unshipped cash-on-delivery order only after a second confirmation, raises a ticket for anything it may not do, and transfers to a verified human in hours. A stranger with no matching number gets the knowledge base and a callback — never someone else's order. |
| **Order confirmation (outbound)** | A cash-on-delivery order arrives; within 30 minutes the AI calls to confirm it, and the answer is written back to the store (tags, a note, and a cancellation only if the merchant switched that on). After 30 minutes it is no longer treated as a transactional call — it is not quietly called the next morning. |
| **Abandoned-cart recovery** | A shopper leaves a cart having ticked Naaradh's own consent box. Forty-five quiet minutes later, one call. If they want the link, the *merchant's* systems send it — Naaradh sends no SMS or WhatsApp. An order that follows within the merchant's window is reported as recovered, and never billed. |
| **Post-delivery feedback** | A day after delivery, one short call asking how it went, with a score and a comment recorded. Skipped for cancelled, refunded, returned and test orders. |
| **Appointments** | The merchant's diary (their own system or a connected Cal.com) produces one reminder call between 24 and 2 hours before the appointment. The customer can confirm, move it (the AI offers only real free slots) or cancel; the merchant's calendar is updated. Nothing clinical is ever discussed. |
| **Merchant dashboard** | Sign in by emailed link; see every call in business terms with the reason anything was *not* called, order calls, support calls, tickets, the knowledge base, scripts (with A/B tests), recovered revenue and return-cost savings, appointments, privacy and opt-outs, billing, team, API keys, and an access log of who read what. |
| **Shopify app** | Installs itself, onboards the merchant, takes the compliance attestation, approves scripts, sets up the support line and handles billing approval. |
| **WooCommerce plugin** | Same jobs for a WordPress store, all server-side: consent checkbox, order reporting, cart reporting, and call results written back as order notes. |
| **Public API** | Any other platform can do everything a Shopify store can: create calls, report orders, carts and appointments, record consent, receive signed webhooks. Documented as OpenAPI. |
| **Staff console** | Complaints, tenant pause and resume, billing disputes, kill switches, erasure requests, phone-number health, the weekly call-quality queue, calendars, and the promotional-pause lift — all behind Google sign-in, all audited. |

---

## 3. What is built, area by area

| Area | State | Where |
|---|---|---|
| Compliance gate (13 ordered checks, full trace of every decision) | Built | `compliance` |
| Inbound admission, caller identity, agent tools (11), two-step cancellation | Built | `compliance`, `voice` |
| Consent ledger, suppressions, complaints, do-not-call page, erasure, retention | Built | `compliance`, `workers` |
| Call pipeline: intake → gate → dial → results → write-back → merchant webhooks | Built | `workers` |
| Database: 46 tables, 14 migrations, row-level isolation per merchant, append-only audit | Built | `db` |
| Regional isolation: one deployment per region, enforced in the gate, the support line and every sweep | Built (ADR-0012); second region is infrastructure work | `compliance`, `workers` |
| Scripts: templates in Hindi, Indian English, US and UK English, German, French and Spanish; disclosure validator, extraction schemas, A/B tests | Built (non-English wording needs a native review) | `call-scripts` |
| Voice engine adapter contract + deterministic simulator (19 scenarios) | Built | `engines` |
| Shopify integration (orders, fulfilments, checkouts, billing, write-backs, install) | Built | `shopify-sdk`, `shopify` |
| WooCommerce plugin (GPL) | Built, not yet listed | `plugins/woocommerce` |
| Appointment calendars (port + Cal.com + a manual diary) | Built; Cal.com payloads unverified | `calendar` |
| Merchant dashboard and public website | Built | `web` |
| Staff console | Built | `console` |
| Billing: plans, allowances, Shopify usage records, Razorpay subscriptions, disputes, reconciliation | Built (rupees) | `pipeline/src/billing` |
| Email (alerts, daily summary), transactional only, no customer data | Built | `notify` |
| Infrastructure as code: 13 Terraform modules, Docker images, CI/CD, monitoring, alerts | Written and validated; **nothing applied** | `infra/` |
| Runbooks for on-call (24), decision records (8 written, 3 planned), phase reviews (6) | Built | `docs/` |

### How thoroughly it is tested

751 automated tests, all passing, in four suites that must stay green:

| Suite | Tests | What it proves |
|---|---|---|
| Compliance regression | 192 | Every rule that can refuse a call, including the nasty edge cases |
| Integration (real Postgres + Redis) | 262 | Whole flows end to end, including merchant isolation and the security policies |
| Unit | 268 | Pure logic: windows, money, phone handling, extraction, statistics |
| Engine contract | 29 | Any future vendor adapter must behave the same way |

111 named edge cases from the specification are implemented and tested — out-of-order webhooks,
a customer ordering while the phone is ringing, a child answering, a wrong number, a shopper
unticking the consent box, a calendar slot taken a second earlier, and so on.

**What the tests do not cover:** a real voice engine, real phone numbers, real Cal.com, the
WooCommerce plugin's PHP (no PHP runner in the build), and anything actually deployed.

---

## 4. What is left — things only a person can do

These are in dependency order. Nothing below is code.

| # | What | Why it blocks | Detail |
|---|---|---|---|
| 1 | Private limited company, GST registration, bank account | Needed for phone numbers, DLT, Razorpay and payouts | [go-live 01](go-live/01-company-and-legal.md) |
| 2 | Voice engine trial on Indian networks, then choose one | No real call can be placed without an engine adapter, and the adapter should be written once | [go-live 03](go-live/03-voice-engine.md) |
| 3 | Phone numbers (+91) and DLT telemarketer registration | Legal prerequisite for outbound calling in India | [go-live 02](go-live/02-phone-numbers-and-dlt.md) |
| 4 | Google Cloud project, Neon database, Redis, Terraform apply | The product has nowhere to run | [go-live 05](go-live/05-cloud-infrastructure.md) |
| 5 | Postmark (email), Razorpay (payments) accounts | Alerts, daily summaries, non-Shopify billing | [go-live 06](go-live/06-email-and-payments.md) |
| 6 | Shopify Partner app (staging + production), protected-data approval, App Store submission | Required to serve Shopify merchants publicly | [go-live 04](go-live/04-shopify-app.md) |
| 7 | Lawyer: consent wording, legal pages, terms, DPA; CA: GST and invoicing | Promotional calling and the App Store both need them | [go-live 01](go-live/01-company-and-legal.md) |
| 8 | A do-not-disturb screening provider (a telecom operator contract) | **Every promotional call is refused until this exists** — by design | [runbook](runbooks/promotional-calling.md) |
| 9 | One live Cal.com booking to verify their API shapes | Appointment booking is written from published docs, never run for real | [go-live 09](go-live/09-woocommerce-and-appointments.md) |
| 10 | WordPress.org listing for the plugin (review queue) | Not a blocker — merchants can install the file directly | [go-live 09](go-live/09-woocommerce-and-appointments.md) |
| 11 | Partner access from one-click checkout providers (GoKwik, Shiprocket, Razorpay Magic, Cashfree) | Those stores can already be served through the public API; native support needs their cooperation | [ADR-0011](decisions/ADR-0011-non-shopify-sources-and-appointments.md) |
| 12 | First merchants onboarded and a pilot run | The commercial goal of Phase 4; nothing technical is waiting on it | [go-live 08](go-live/08-first-merchants.md) |

---

## 5. What is left — engineering work

### Carried from finished phases (small, known)

| Item | Note |
|---|---|
| Voice engine verification | All three vendor adapters are built; each needs its account and recorded test calls to settle the `[VERIFY]` items ([go-live 03](go-live/03-voice-engine.md)) |
| `reactivation` ("win back an old customer") | Declared with its limits and purpose, but no trigger, script or tests. Cannot be switched on by accident |
| `delivery_reschedule` | Same: reserved and rate-limited, not implemented |
| Automatic triggers for appointment *booking* calls | Bookings work through the API and on a call; there is no "call everyone who asked" trigger |
| PHP in the build pipeline | The WooCommerce plugin's checks are a written manual matrix |
| Dev-store test matrix | Needs the Partner app to exist. (The Flow trigger is built; it goes live with the app deploy.) |
| Onboarding test call | Needs a product decision on test intents and billing (Q-37) |

### Phase 6 — United States and Europe (code built, nothing live)

The core is ready for this; an audit before the phase confirmed it.
The compliance layer already decides by the *customer's* region: calling hours, what counts as
consent, which numbers may dial, which engine, which language the disclosure is in.

What Phase 6 must build, largest first:

1. ~~**Regional data isolation** — decision~~ **done** ([ADR-0012](decisions/ADR-0012-regional-isolation.md)):
   one deployment serves one region, and the code now refuses anything else — the gate, the
   support line and every background sweep check the region before they touch a tenant. What is
   left is infrastructure: a second and third deployment (database, storage, queues) in their own
   regions, and edge routing for webhooks and phone numbers.
2. ~~**Scripts in US English, UK English, German, French and Spanish**~~ **done**: cart-recovery
   and appointment scripts in all five, seeded by the merchant's country. The German, French and
   Spanish wording is a draft and needs a native speaker's review before a merchant approves it.
3. ~~**The Retell adapter**~~ **built** against a stand-in of Retell's published API: outbound
   calls, tools, signed webhooks. Incoming calls, warm transfer and cancelling a queued call are
   switched off until they are seen working (Q-31). Calls to +1 numbers go only from numbers a
   person has recorded as A-attested (Q-28).
4. ~~**A dollar payment path**~~ **built** with Stripe: checkout from the dashboard or the API,
   usage on the next invoice, webhooks checked with Stripe before anything changes. Euros and
   pounds wait on a pricing decision (Q-30). `/pricing/us` shows the dollar prices as early access.
5. ~~**US and UK do-not-call screening**~~ **built**: the national lists are loaded from their
   licensed files, and marketing calls stop by themselves if a list is missing or too old.
6. **Calling hours, holidays and recording consent** per country are **built** as the strictest
   rules we know of, and wait on a lawyer to confirm (Q-29, Q-32).
7. **The US and EU deployments** are written as Terraform (and routing between regions is
   built), but not switched on.

Everything left is outside the code: [go-live 10](go-live/10-us-eu.md) lists it in order —
counsel, the Retell account, the two cloud projects, numbers, the do-not-call licences, Stripe.

### Phase 7 — Scale (not started)

Menu-style inbound routing, multiple profiles per number, a self-hosted engine evaluation once
volume justifies it, enterprise features (single sign-on, custom voices, dedicated numbers,
SLAs), SOC 2 readiness, and a US parent company only if raising US capital.

---

## 6. Decisions waiting on you (or a lawyer)

37 questions are tracked with a conservative default in force for each, so no code is blocked
([full list](open-questions.md)). The ones that matter most:

| Question | What is in force meanwhile |
|---|---|
| Which number series may place service calls, and whether transactional calls need screening (Q-01, Q-02) | Numbers are set by hand per merchant; everything is screened |
| The exact consent wording for calls, per language (Q-08) | A draft wording is used and recorded; it is marked as a draft everywhere |
| Whether a shopper who never saw the checkout box can be called (Q-22) | They cannot |
| Who sends the cart link — you or the merchant (Q-21) | The merchant. Naaradh sends no messages |
| Whether a recovered cart is ever billable (Q-24) | It is not. Recovery is measured only |
| Whether promotional voice calls need registered templates (Q-23) | They do, and the gate enforces it |
| US recording-consent states (Q-12) | Every call announces the recording, everywhere |
| Whether a database in Singapore is acceptable (Q-16) | It is disclosed as-is; every database object stays portable |
| Serving, waitlisting or blocking non-Indian stores (Q-20) | Waitlisted: the app installs and never calls |
| Renaming the rupee-specific money fields before non-rupee customers exist (audit §4.7) | Names unchanged; they hold minor units of whichever currency, with the currency stored beside them |

---

## 7. Risks worth keeping in view

- **Regulatory, and it is existential.** Five valid complaints in ten days can get every phone
  resource blacklisted. The product pauses a merchant at three complaints and stops all calling
  at five, screens numbers, records consent with the exact wording shown, and refuses anything
  it cannot prove. That is the reason promotional calling cannot start before a screening
  contract exists — and why that refusal is deliberate, not a bug to work around.
- **Vendor dependency.** One voice engine, unchosen. The adapter contract means switching is a
  package, not a rewrite, but until one is picked nothing can call.
- **Nothing has run in production.** Every number above comes from tests on one machine. The
  first week live will find things no test can.
- **Data residency.** One database, in Singapore, for all merchants. Fine for India today,
  disclosed in the legal drafts, and the first real constraint for Europe.
- **One person.** The build is wide. The runbooks exist so that a second person can operate it
  without reading the code.

---

## 8. Phase by phase

| Phase | Goal | State |
|---|---|---|
| 0 | Engine bake-off, decide the India vendor | **Not started** — needs vendor accounts |
| 1 / 1B | Call pipeline, compliance gate, the inbound agent | **Code complete** |
| 2 | Shopify app, dashboards, billing, complaints, privacy | **Code complete** |
| 3 | Hardening, security checklist, legal drafts, App Store prep | **Code complete**; every exit criterion needs a person |
| 4 | Promotional calling: carts, feedback, A/B, QA sampling | **Code complete**; cannot run without screening + wording |
| 5 | WooCommerce, other platforms, appointments, automation | **Code complete**; vendor items open |
| 6 | United States and Europe | **Code built, not live**: regional isolation (ADR-0012), Western scripts, Retell adapter, US/EU calling rules, do-not-call lists, Stripe, region routing; accounts, legal review and deployment remain ([go-live 10](go-live/10-us-eu.md)) |
| 7 | Scale and optionality | **Not started** |

---

## 9. Where the detail lives

| Document | For |
|---|---|
| [go-live/](go-live/README.md) | Every account, registration and approval needed from outside the code, in order |
| [open-questions.md](open-questions.md) | The 27 unresolved questions and the safe default in force for each |
| [decisions/](decisions/README.md) | Why the product works the way it does — 8 written decisions, 3 planned |
| [runbooks/](runbooks/README.md) | What to do when something breaks, symptom first |
| [NAARADH_BUILD_SPEC.md](NAARADH_BUILD_SPEC.md) | The full specification, including all 111 edge cases |
| [api/](api/README.md) | The API reference, automation recipes, webhook verification |
| [../PLAN.md](../PLAN.md) | The phased plan with ticket numbers and exit criteria |
| [../README.md](../README.md) | Engineering entry point: how to run it locally |
| [../CLAUDE.md](../CLAUDE.md), [../AGENTS.md](../AGENTS.md) | The 19 rules the code may never break, and the engineering reference |

*Every claim in this document is traceable to a test, a document or a named gap. Where something
is unverified it says so.*
