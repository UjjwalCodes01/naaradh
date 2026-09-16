# Phase 5 review — Integrations expansion (code half)

**Date:** 16 Sep 2026 · **Verdict:** the code for "be reachable from every stack an Indian SMB
uses" is built and tested — one cart-ingestion contract, a WooCommerce plugin, an appointments
vertical with a calendar port, and automation recipes on the existing API. What remains is
vendor-shaped and human: a WordPress.org listing, one-click-checkout partner access, CRM OAuth
clients, and a single live Cal.com booking to verify payload shapes. Decisions: ADR-0011.

## Exit criteria

| Criterion | Status | Evidence |
|---|---|---|
| WooCommerce plugin listed; ≥ 3 Woo merchants live | **Plugin built, not listed** — a merchant can install the zip today; listing is review-queue work (Q-27) | `plugins/woocommerce` (993 lines PHP), `docs/go-live/09-woocommerce-and-appointments.md` |
| At least one OCC provider live; cart coverage for non-Shopify-Checkout stores | **Coverage exists without a provider deal** — any platform posts carts to `PUT /v1/carts/{ref}` under the same ADR-0010 rules; vendor parsers still blocked (Q-09) | `apps/api/src/routes/carts.ts`, `apps/api/test/int/api.test.ts` |
| Zoho + Cal.com flows live with ≥ 3 appointment tenants | **Cal.com built (`[VERIFY]`, Q-25); Zoho waits for an OAuth client** — lead-callback already works over the API | `packages/calendar`, `apps/voice/src/tools/appointments.ts`, `docs/api/automation.md` |

## Tickets

| Ticket | Status |
|---|---|
| P5-WOO-1 plugin | ✅ consent checkbox (classic + block checkout, wording version stored), COD → intent, every order → order cache, carts with consent → cart API, results → order notes via a signed REST route, HPOS-compatible, i18n-ready, uninstall cleanup |
| P5-WOO-2 WordPress.org submission | ◐ `readme.txt` with the external-service disclosure written; submission and review are human (Q-27) |
| P5-WOO-3 test matrix | ◐ written as a manual matrix — there is no PHP runner in this repo's CI, and adding one buys little for ~1k lines |
| P5-OCC-1 partner access | ◐ human, blocked (Q-09) |
| P5-OCC-2 provider sources | ◐ **deliberately not guessed**: no vendor parser until payloads can be verified; those stores use the cart API meanwhile (ADR-0011 §2) |
| P5-CRM-1/2 Zoho, HubSpot | ◐ blocked on per-vendor OAuth apps; recipes documented so the flows work today |
| P5-CAL-1 calendars + appointment scripts | ✅ `CalendarPort` with Cal.com (`[VERIFY]`) and a manual diary, `get_slots`/`book_slot` tools, appointment confirm/book scripts (hi-IN, en-IN) with healthcare guardrails, reminder sweep, provider cancellation sync |
| P5-AUT-1 Zapier/Make/n8n | ✅ `docs/api/automation.md` — triggers, actions, raw-body signature verification, rate-limit advice |
| P5-API-1 SDKs | ✅ `docs/api/sdks.md` — generate from the published OpenAPI document; verification snippets in Node, Python, PHP |
| P5-GTM-1 appointment pilot | human |

## What was built

- **Schema (migration 0013):** `calendars` (provider, event type, timezone, slot length, a
  Secret Manager *reference* — never a credential, provider config) and `appointments` (phone
  hash, contact, service, start, timezone, status, provider booking id, the reminder intent, the
  attempt that booked it, provider-cancellation state), both with tenant RLS forced and policies.
- **`packages/calendar`:** the port (`listSlots`, `book`, `cancel`, `reschedule`), a Cal.com
  adapter over `fetch` with strict parsers and typed failures (`CalendarUnavailable`, `SlotTaken`,
  `CalendarRejected`), a deterministic fake with outage/full/taken scenarios, and a registry.
- **API:** `PUT /v1/carts/{ref}`, `POST /v1/carts/{ref}/completed`, `GET /v1/carts/{ref}`,
  `PUT|GET /v1/appointments/{ref}`, `GET /v1/appointments`, `GET /v1/calendars`; three new scopes;
  all seven documented in the OpenAPI document (drift-checked).
- **Agent tools:** `get_slots` and `book_slot`. Offers are kept on the `agent_actions` row rather
  than in the model's context, bookings are idempotent on the tool-call id, and a booking exists
  only when the provider confirmed it.
- **Workers:** reminder sweep on the reconcile tick; appointment status from a call's outcome;
  a cancellation pushed to the provider with transient/permanent error handling; erasure covers
  appointments.
- **Surfaces:** merchant Appointments page (diary + why each call was or was not queued), console
  Calendars page (connect, disable, next appointments), and the WooCommerce settings screen's own
  diagnostics.
- **WooCommerce plugin:** server-side only, GPL, HPOS-compatible; never cancels or edits an order.

## Defects found and fixed while building

- The appointment reminder used the appointment reference as the intent's external ref, so a
  **moved appointment was refused as a duplicate** and lost its call. The ref now carries the
  time the call is for (E-133), which keeps duplicate protection for the same time.
- `get_slots` first returned its offer list in the tool result, putting the raw slot ids in the
  model's context. Offers now live only on the action row; the model sees ids and spoken times,
  and `book_slot` validates against the row (E-132).
- The appointment extraction schema could not record `needs_merchant_action`, which the clinical
  branch of the new scripts needs — caught by the Phase 4 test that every branch outcome must be
  storable.
- `refreshDnd`-style error caching, `qa_reviews` RLS and the A/B p-value were Phase 4 fixes; this
  phase added a `CONFLICT` error code (409) so a taken slot is not reported as a validation error.

## Not done / carried

- **Cal.com payloads are `[VERIFY]`** (Q-25): one live booking must confirm the shapes. The
  failure mode is safe (a strict parser refuses and the agent offers a callback) but it is still
  untested against reality.
- Google Calendar (per-merchant OAuth), CRM marketplace apps, one-click-checkout parsers.
- PHP is not linted or unit-tested in CI; the plugin's matrix is manual (go-live 09).
- `reactivation` still has no trigger or template (carried from Phase 4).
- Terraform unchanged this phase; not re-validated (disk space on the dev machine).
