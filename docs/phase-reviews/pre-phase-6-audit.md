# Pre-Phase-6 audit — is the core stable enough for US/EU?

**Date:** 16 Sep 2026 · **Scope:** everything built in Phases 1–5, read against what Phase 6
needs (`PLAN.md`: region-isolated infrastructure, a second voice engine, US/EU consent,
disclosure and windows, Western pricing). **Method:** every gate run green, then a read of each
region-sensitive path and a defect pass over the newest code (Phases 4–5, the least reviewed).

**Verdict: the *calling core* is ready; the *deployment* is not, and that is Phase 6's own
work.** The compliance layer already decides by recipient region — windows, consent sources,
CLI pool, engine routing, disclosure locale — and has regression tests for US and EU cases. What
does not exist is regional isolation of the data itself (one database, one recordings bucket, one
Pub/Sub project), a Retell adapter, US/EU script templates, and a USD payment path. None of
those is a defect in what is built; each is a Phase 6 ticket, listed below with the seam it needs.

Six real defects were found and fixed in this pass (§3). One of them — appointment reminders
being impossible in India — made a Phase 5 feature unusable rather than merely wrong.

## 1. Gates at the time of writing

| Gate | Result |
|---|---|
| `pnpm lint`, `pnpm lint:pii`, `pnpm format:check` | clean |
| `pnpm typecheck` (root + `apps/web` + Shopify app) | clean |
| `pnpm test` (unit) | 268 passed |
| `pnpm test:compliance` | 192 passed |
| `pnpm test:contracts` | 29 passed |
| `pnpm test:int` (Testcontainers) | 262 passed |
| `pnpm openapi` drift | none (regenerates identically) |
| `terraform validate` | not re-run — nothing under `infra/` changed since Phase 3, and the dev machine has ~2 GB free |

## 2. What Phase 6 will find already done

- **Recipient-region rules are the gate's own logic, not a branch bolted on.** `windowFor()`
  resolves a window from the recipient's zone, the contact's zone hint, or the country's
  coast-to-coast intersection (US and CA list their extreme zones); `consentRulesFor()` gives
  India opt-in, the US written consent for promotional (TCPA) and the EU opt-in for *every*
  automated call, with unknown regions falling to the strictest set. Regression tests cover a US
  number needing written consent, a US transactional call needing none, an EU transactional call
  needing opt-in, and the coast-to-coast intersection.
- **Engine and CLI routing are already per region.** `engines.defaultFor(region)` /
  `secondaryFor(region)` with a per-tenant override, and CLI candidates are filtered on
  `n.region === intent.recipientRegion`, so a foreign CLI into India is impossible by
  construction (and the reverse too).
- **Disclosures exist for `en-US`, `en-GB`, `de-DE`, `fr-FR`, `es-ES`** alongside the Indian
  locales, and the validator refuses a script whose opening lacks the locale's AI + recording
  lines. `Locale` in `packages/engines/core` already covers them.
- **Money is minor units plus a currency code everywhere it is stored**, and `effectivePlan()`
  resolves prices in the tenant's own currency (USD tables exist for every plan).
- **`tenants.data_region`** is computed at provisioning (`dataRegionFor()`) and stored, ready to
  route on.
- **Non-India stores are waitlisted, not half-served** (Q-20): the Shopify app shows "coming to
  your region" and no calling state is created.

## 3. Defects found and fixed in this pass

1. **Appointment reminders were impossible in India** (severity: feature dead on arrival). A
   reminder is a *service* purpose, which the Indian and EU rules require a consent record for,
   but `PUT /v1/appointments/{ref}` had no way to say how the customer asked — so every reminder
   would have been refused `consent:missing`. Fixed by giving the appointment a `consent` block
   (recorded once per appointment in the same ledger) and by having `book_slot` record `verbal`
   consent with the call as its evidence. The gate was not touched. Tests: an appointment without
   consent is kept but refused; one with consent dials and confirms.
2. **A reschedule left the old slot booked** (severity: wrong diary for the merchant). When a
   customer rescheduled on a reminder call and the agent booked a new slot, the old appointment
   was marked `rescheduled` and never released with the provider — two live bookings for one
   customer. Now the old row is cancelled *only when a replacement was actually booked* (so a
   failed rebooking never leaves the customer with nothing), which is what makes the reconcile
   tick release the slot. The rule is a pure function with its own tests.
3. **The DND provider was called inside the gate transaction** (severity: availability). A slow
   scrub would have held the intent row — and a Postgres transaction — for the provider's whole
   timeout, the exact failure the Shopify write-back is structured to avoid. The scrub now runs
   before the transaction opens; the cache it fills is global and needs no tenant context.
4. **The calendar adapter could answer after the agent had given up.** Its timeout was 6 s
   against tool budgets of 4 s (`get_slots`) and 5 s (`book_slot`), so a slow provider meant
   silence on the call and possibly a booking nobody heard about. Default is now 3 s; the
   reconcile tick, where nobody is waiting, passes 8 s.
5. **Appointments never aged out.** Orders (180 days) and checkouts (30 days) lose their phone
   link on a schedule; appointments kept theirs for ever. The retention worker now erases them at
   `APPOINTMENT_RETENTION_DAYS` (180), keeping the time and the service.
6. **A cart token could match another platform's cart.** `convertCheckouts` matched a checkout
   reference across every source, so two platforms using the same reference could convert each
   other's carts. The match is now scoped to the source that reported it.

## 4. What Phase 6 must build (not defects — missing by design)

| # | Gap | The seam that exists today | Recommendation |
|---|---|---|---|
| 1 | **One database for every region.** All tenants live in one Neon project (Singapore, ADR-0004, Q-16), so a US or EU tenant's hashes, encrypted numbers and outcomes would sit outside their region. | Every query is either `withTenant(app, tenantId, …)` or a documented cross-tenant service query. | An ADR first, then a per-region pool map keyed by `tenants.data_region`, with a region-scoped tenant directory. The workers' cross-tenant sweeps must become per-region loops; that is the largest single change in Phase 6. |
| 2 | **One recordings bucket and one Pub/Sub project.** `RECORDINGS_BUCKET` is a single env value; recordings for an EU call would land in Mumbai. | `ctx.recordings` is already an injected `RecordingStore` port. | A store per region selected by the tenant's `data_region`, and one topic set per region. Same for the BigQuery export. |
| 3 | **No Retell adapter** (P6-ENG-1). | `VoiceEngineAdapter`, the contract-test harness and `engines.defaultFor('US')` are all in place; the simulator proves the contract. | Build against the contract tests; nothing in product code needs to change. |
| 4 | **No script templates outside `hi-IN` / `en-IN`.** `ensureDefaultSetup()` only accepts those two, and a non-India store is currently seeded `en-IN`. | Disclosures for `en-US`, `en-GB`, `de-DE`, `fr-FR`, `es-ES` already exist and are enforced. | Ship templates per locale, widen the locale union, and pick the default from the tenant's country. Do those together: widening the union without templates would create tenants with no scripts. |
| 5 | **No USD/EUR payment path.** Razorpay is INR-only (and refuses Shopify-billed stores); Stripe is named in the plan and not built. | `billing_ledger` carries `currency`; `effectivePlan()` resolves USD prices; `billing_provider` enum already includes `stripe`. | Build the Stripe subscription + usage path as a sibling of the Razorpay one, reusing `billing_postings`. |
| 6 | **No US DNC scrub provider** (the US twin of Q-02). | The `DndProvider` port takes a region; the gate fails closed on `unknown`. | A SAN-registered provider for the US National DNC Registry. Note that `DND_SCRUB_TRANSACTIONAL_DEFAULT = true` scrubs US transactional calls too — conservative, and worth revisiting with counsel since US informational calls are generally out of scope. |
| 7 | **`*_paise` field names hold minor units of any currency.** `spend_cap_daily_paise`, `valuePaise`, `rto_cost_paise`, `overagePaise` are all correct (minor units + a currency code) but read as INR-only. | — | Rename to `*_minor` in one migration before US tenants exist, or accept the names and document them. A decision, not a silent refactor. |
| 8 | **Two-party recording-consent states (Q-12)** are handled by always announcing the recording, which is the safe default but not a legal review. | Disclosure is invariant 7 and enforced by the validator. | Close Q-12 with counsel before the first US call. |

## 5. Smaller notes, deliberately not changed

- `INBOUND_PLANS` is an INR-only reference table; metering reads the tenant's currency through
  `effectivePlan()`. Now documented in place so nobody meters from it.
- Appointments booked by the agent are stored `confirmed`, so they get no *further* reminder. A
  booking made three weeks ahead arguably deserves one; that is a product decision, not a bug.
- A merchant-cancelled appointment with a provider reference is also cancelled with the provider.
  If the merchant already cancelled it in their own system, the provider answers "unknown
  booking" and the row is stamped so it is not retried.
- `GET /v1/carts/{ref}` uses the `carts:write` scope (there is no `carts:read`), so one key
  serves the whole plugin. Worth splitting only if a read-only consumer appears.
- Every cart from the public API is stored with source `api`, whichever platform sent it; the
  cart reference is the tenant's own namespace. Per-platform sources exist for webhook paths
  (`shopify`) and would be added with a provider integration.
- PHP is not linted or tested in CI. The WooCommerce plugin's matrix is manual
  (`docs/go-live/09-woocommerce-and-appointments.md`).
- `reactivation` still has attempt caps and a purpose but no trigger, template or tests. It
  cannot be switched on by accident (no use case is created for it), and it stays out of scope
  until a phase asks for it.

## 6. Before Phase 6 starts

1. An ADR for regional data isolation (gap 1 and 2) — it decides the shape of most Phase 6 work.
2. Close Q-12 (US recording consent) and Q-25 (Cal.com payloads) — both need one person-hour of
   outside input each, and both block a live call in their area.
3. Decide gap 7 (`*_paise` naming) while there are no non-INR tenants to migrate.
