# ADR-0011 — Non-Shopify sources (WooCommerce, one-click checkouts) and the appointments vertical

**Status:** accepted (Cal.com request/response shapes: **`[VERIFY]`** against their live API before go-live)
**Date:** 16 Sep 2026
**Deciders:** Founder (implemented by agent, PLAN Phase 5 — P5-WOO-1…3, P5-OCC-1…2, P5-CAL-1, P5-AUT-1, P5-API-1, P5-CRM-1…2)
**Invariants touched:** 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 14, 15, 17, 18, 19
**Edge cases:** E-13, E-14, E-42, E-45, E-52 and the new E-120…E-139 below

## Context

Phase 5 asks for two different things: *be reachable from every stack an Indian SMB uses*, and
*add the appointment vertical*. Both risk the same mistake — one integration per vendor, each
with its own rules, each able to bypass the gate. Every decision below points the other way: one
contract, one gate, one set of limits, with vendor code confined to a thin adapter.

## Decisions

1. **One ingestion contract for carts, not one per platform.** `PUT /v1/carts/{ref}` records or
   updates a cart exactly as `checkouts/create|update` does for Shopify, and
   `POST /v1/carts/{ref}/completed` closes it. Naaradh then runs the same sweep as Shopify:
   45 idle minutes, under 24 hours old, a phone, a live consent from **our** wording, one call,
   one promotional call per phone per 7 days (ADR-0010). WooCommerce, a one-click checkout
   provider, or a bespoke store all use this one route, so the rules cannot drift per platform.

2. **No vendor-specific one-click-checkout parsers until there is partner access (Q-09).**
   GoKwik, Shiprocket Checkout, Razorpay Magic and Cashfree send no `checkouts/*` webhook and
   publish no payload we can verify. Writing parsers from guesses would put unverified
   assumptions in the middle of a promotional call. Until a partner agreement exists, those
   stores integrate through decision 1 (the merchant's own glue posts the cart) — and E-111 stays
   true: no cart data, no recovery call, and the dashboard says so.

3. **The WooCommerce plugin talks to the API from the server, never the browser.** The API key
   lives in WordPress options, calls go out from PHP, and the plugin ships no key to a page. It
   does four things: a consent checkbox at checkout that stores the wording version on the order;
   COD orders → `POST /v1/intents`; every order → `PUT /v1/orders/{id}` (the order cache the
   support line answers from) and `PUT /v1/carts/{ref}/completed`; carts with a phone **and** a
   ticked box → `PUT /v1/carts/{ref}`. Results come back to a WordPress REST route that verifies
   the Naaradh webhook signature and writes an order note. The plugin never cancels or edits an
   order by itself (invariant 14) — a cancellation arrives as a note and, if the merchant enabled
   it, is still executed by a person.

4. **Consent wording is one list, and platforms copy from it.** `CONSENT_WORDINGS` in
   `pipeline` stays the only source: the WooCommerce checkbox, the Shopify extension and
   the cart block all render the current version's text, and a test fails when a copy drifts. A
   cart or order that names an unpublished version is not consent (E-106).

5. **Appointments are the merchant's calendar, seen through a port.** `calendar` defines
   `CalendarPort` — `listSlots`, `book`, `cancel`, `reschedule` — with a Cal.com adapter and a
   deterministic fake for tests. Product code never imports a calendar SDK (the rule that keeps
   voice vendors out of product code, invariant 13, applied to calendars). Google Calendar needs
   OAuth per merchant and comes later.

6. **The agent may never invent a time.** `get_slots` returns only what the provider offered, and
   `book_slot` accepts only a slot id from that same call's offer list, for the caller's **own**
   verified number, with the tenant's appointments setting on. Every booking writes an
   `appointments` row and an `agent_actions` row; a double-book, an expired offer or a slot the
   provider has since taken comes back as "that time has gone" and the agent offers the current
   list again. Nothing is "confirmed" to a customer that the provider did not confirm.

7. **An appointment carries the consent that makes its reminder lawful.** A reminder is a
   *service* call, and India (and the EU) want a consent record for one — the gate refuses
   `consent:missing` otherwise, and it is right to. So `PUT /v1/appointments/{ref}` takes an
   optional `consent` block (how the customer asked: a booking form, the merchant's app, a phone
   call), recorded in the same ledger as every other consent, once per appointment. When the
   agent books on a call, the ask itself is the evidence: the tool records `verbal` consent with
   the attempt as its evidence URI. An appointment sent without consent is still kept — the
   support line can answer "do I have an appointment?" — it just never produces a call.

8. **Appointment reminders come from the appointment, not from a call.** An `appointments` row
   with `starts_at` in the future produces one `appointment_confirm` intent inside the existing
   envelope (24 hours to 2 hours before the appointment, recipient's zone, 09:00–21:00). Moving
   the appointment moves the reminder; cancelling it cancels the intent.

9. **Appointment calls stay away from medicine.** The shipped appointment scripts forbid
   diagnosis, prescriptions, test results and any clinical advice, and say so in their
   `forbidden_topics`; anything clinical becomes a ticket or a transfer. A lab or clinic tenant
   gets the same guardrails as everyone else — the vertical changes the script, not the rules.

10. **Automation platforms get recipes, not integrations.** Zapier, Make and n8n can already
   create intents and receive `outcome.final`; Phase 5 ships documented recipes and signature
   verification snippets (`docs/api/automation.md`) instead of three more OAuth apps to maintain.

11. **CRM integrations wait for their OAuth apps.** Zoho and HubSpot (P5-CRM-1/2) need a
    published OAuth client per vendor and a marketplace listing — human work. The lead-callback
    use case they feed already works through `POST /v1/intents` with a public site key, and that
    is what the docs recommend until the apps exist.

12. **Billing is unchanged.** A booked appointment is `booked`, which is already in the billable
    set (invariant 11). Nothing in this ADR adds or removes a billable outcome.

## New edge cases

| Id | Case | Behaviour |
|---|---|---|
| E-120 | A platform posts a cart with no phone, then adds one | Same as E-100: updated, swept once idle with a phone |
| E-121 | A platform posts a cart without the consent box ticked | Recorded for the funnel, never called (`consent:missing`) |
| E-122 | A platform posts carts faster than a shopper could abandon them (loop, bad cron) | Idempotent on (tenant, source, ref); the per-key daily cap and the 7-day cooldown bound the damage |
| E-123 | WooCommerce order placed for a cart Naaradh was about to call | `completed` closes the cart; a queued intent is cancelled (E-102) |
| E-124 | The WordPress site is offline when a result is sent | Naaradh retries the webhook with backoff and dead-letters after 5; the merchant sees it in Developers → webhook health |
| E-125 | Someone forges a result to the plugin's REST route | Signature (HMAC, timestamp window) verified before the body is parsed; a bad one is 401 and logged, never a note |
| E-126 | The plugin's API key is revoked or wrong | Calls fail closed, an admin notice appears, nothing is queued; orders still work |
| E-127 | WooCommerce guest checkout with no phone field | Nothing is sent; the plugin says why on the settings page |
| E-128 | A merchant edits the consent wording in the theme | The wording version is what is recorded; edited text is a merchant AUP breach, and the stored version still says which text Naaradh published |
| E-129 | Calendar provider unreachable during a call | `get_slots` returns nothing; the agent offers a callback ticket, never a made-up time |
| E-130 | Two callers book the same slot at once | The provider's booking is the arbiter; the loser hears "that time has just gone" and is offered the current list |
| E-131 | Caller asks to book for someone else's number | Refused; appointments are booked only for the caller's verified number (or the number Naaradh dialled) |
| E-132 | Slot offered, caller silent, offer used minutes later | Offers expire with the call; a stale slot id is refused and the list is re-read |
| E-133 | Appointment moved or cancelled in the merchant's calendar after a reminder was queued | The sweep re-reads the appointment: moved → the reminder moves, cancelled → the intent is cancelled |
| E-134 | Appointment less than 2 hours away when it is created | No reminder call (inside the envelope's `notAfter`); the merchant sees the reason |
| E-140 | Appointment sent with no consent record | Kept for the support line; the reminder is refused `consent:missing` (§7) |
| E-141 | Customer reschedules on a reminder call and the agent books a new slot | The old row is cancelled so the provider releases the slot; without a new booking it stays `rescheduled` and nobody's appointment is lost |
| E-135 | Appointment at 08:00, reminder due the evening before after 21:00 | Window rules win (invariant 3): the reminder is placed at 09:00 only if that is still ≥ 2 hours before |
| E-136 | Caller asks a clinical question on an appointment call | Never answered; ticket or transfer to the clinic's staff |
| E-137 | A merchant sends appointments for a customer who opted out | Suppression is absolute (invariant 6): no reminder call; the appointment stays in their calendar |
| E-138 | A CRM or automation tool creates a lead-callback intent with no consent | Service purpose: allowed by the gate's consent rules for a customer-initiated callback, refused for anything promotional |
| E-139 | Two platforms report the same cart (Woo plugin plus a provider) | One row per (tenant, source, ref); duplicates across sources collapse at the 7-day phone cooldown, so one call at most |

## Consequences

- A new platform is a client of the public API, not a new branch in the consumer. The only
  vendor-shaped code added in Phase 5 is `calendar/src/calcom.ts` and the WordPress
  plugin, both replaceable.
- WooCommerce merchants get COD confirmation, the support-line order cache, cart recovery and
  feedback through the same gate as Shopify merchants, with no Shopify-specific behaviour.
- The appointments vertical can be sold before Google Calendar exists, and the `[VERIFY]` on
  Cal.com's payloads is the only thing between the adapter and production.
- Nothing here can place a promotional call that ADR-0010 would have refused: the sweep, the
  consent rules, the DND scrub and the DLT template requirement are the same code.
