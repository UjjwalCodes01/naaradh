# Phase 4 review — Promotional use cases (code half)

**Date:** 16 Sep 2026 · **Verdict:** the promotional machinery is code-complete and tested
locally — abandoned cart, post-delivery feedback, script A/B tests, the Results page, the weekly
QA sample and the promotional pause. **No promotional call can be placed yet, by design:** each
one needs something only a person can produce (a TSP DND scrub contract, counsel-approved consent
wording, DLT registration and templates). The exit criteria are commercial (10 paying merchants)
and are not an engineering outcome. Decisions: ADR-0010.

## Exit criteria

| Criterion | Status | Evidence |
|---|---|---|
| ≥ 10 paying merchants; ≥ 5,000 billable outcomes/month; margin ≥ 50% | **Not started** — GTM is human work | — |
| Abandoned cart live for ≥ 3 merchants, zero non-consented promotional calls | **Blocked** on Q-02 (DND provider), Q-08 (wording), DLT templates (Q-23). The audit query is ready | `docs/runbooks/promotional-calling.md`; the gate refuses without consent (`gate.promotional-phase4.test.ts`, `apps/workers/test/int/promotional.test.ts`) |
| Complaint rate < 0.1%; no auto-pause from real complaints | **Instrumented** — promotional complaints now pause promotional calling at once | `recordComplaint`, console, `promotional.paused` |

## Tickets

| Ticket | Status |
|---|---|
| P4-SHOP-1 consent checkbox | ◐ checkout UI extension (Plus) + cart theme block (all plans), attribute `naaradh_call_consent=<wording version>`, never pre-ticked; wording draft (Q-08), Plus/cart equivalence (Q-22); deploy is human |
| P4-SHOP-2 abandoned checkout ingestion | ◐ `checkouts/*` cached, swept after 45 idle minutes, 24 h expiry, one attempt, 7-day cooldown, DND scrubbed at dial time — provider pending (Q-02) |
| P4-SHOP-3 script + extraction | ◐ `ABANDONED_CART_HI_IN`/`EN_IN`, extraction `will_complete`/`will_buy_later`/`not_interested`/`price_objection`/`wants_link`; the link is the merchant's to send (`checkout.recovery_requested`, Q-21) |
| P4-CMP-1 gate hardening | ✅ `attempts:promotional_cooldown`, per-use-case attempt caps, `script:dlt_template_missing`, template id on every attempt, complaint purpose/use case, `tenant:promotional_paused` |
| P4-CMP-2 feedback | ✅ delivered fulfilment → one feedback intent 24–72 h later; skipped for cancelled/refunded/returned/test orders; same consent gate |
| P4-WEB-1 A/B | ✅ start/end from the dashboard, arm by intent hash, per-arm metrics, no leader below 100 answered per arm, approvals blocked during a test, one approved script per arm enforced by the database |
| P4-WEB-2 Results page | ✅ checkout funnel with skip reasons, recovery calls and outcomes, recovered orders/revenue (reversals excluded), COD RTO-avoided estimate from the merchant's own RTO cost, charges in the period |
| P4-BILL-1 recovery definition | ◐ measured, not billed (Q-24): last touch, human-answered, 24 h default (1–72), reversed on cancellation, `order.recovered` with `billable: false` |
| P4-OPS-1 QA sample | ✅ Monday job (2%, min 1, max 20 per tenant, deterministic), console queue with rubric, audited transcript access, accuracy table, `qa-review.md` |
| P4-OPS-2 CLI health | ◐ from Phase 3, unchanged |
| P4-GTM-1…4 | human |

## What was built

- **Schema (migration 0012):** `checkouts`, `attributions`, `qa_reviews` (RLS; `qa_reviews` has no
  app-role grant); `call_attempts.dlt_template_id`; `complaints.purpose/use_case`;
  `orders.is_test/checkout_token`; `tenants.promotional_paused_at/_reason` (service-only column);
  six new outcomes; A/B arm constraint and one-approved-per-arm index.
- **Gate:** promotional pause, 7-day promotional cooldown on dialled attempts, per-use-case
  attempt caps, DLT template requirement, A/B arm selection; regression suite covers each.
- **Pipeline:** checkout recording/sweep/conversion/erasure, order-consent recording, attribution
  and reversal, feedback intents, A/B, Results report, QA sampling, DLT template checks at approval
  and at switch-on, ROI settings.
- **Workers:** consumer handles checkouts, conversion, attribution, reversal and deliveries;
  dispatcher scrubs DND and copies the template id; finalize exhausts capped use cases, emits
  `checkout.recovery_requested`, writes back only order use cases; complaints worker pauses
  promotional; reconcile sweeps checkouts and runs the weekly QA sample; retention strips checkout
  phones after 30 days.
- **Surfaces:** dashboard Results page, A/B controls and template id on Call scripts, ROI settings,
  promotional-pause banner, template id on call detail; Shopify app template id on approval;
  console QA queue and promotional lift; three merchant events documented in OpenAPI.

## Defects found and fixed while building

- Abandoned-cart and lead-callback extractions produced outcomes the database could not store
  (`recovered`, `qualified`, `not_interested`…), so those calls became `inconclusive` and were
  **retried**. Outcomes added; a unit test now asserts every extraction outcome is storable.
- Write-back ran for every use case; a cart call would have tried to tag a checkout token as an
  order. Now only `cod_confirm` / `delivery_reschedule`.
- COD orders recorded the consent attribute without checking the wording version (E-106).
- `refreshDnd` cached a provider *error* as `unknown` for 24 h, blocking promotional calls for a
  day after one timeout. Errors are no longer cached.
- The A/B p-value used the wrong normal-CDF argument (off by √2); caught by a reference-value test.
- `qa_reviews` shipped with RLS forced but no policy (the app role had no grant, so nothing
  leaked); the RLS completeness test caught it and the table now has the standard policy too.
- A dashboard integration test compared the database clock with the fixed test clock and began
  failing as the calendar moved; pinned to the test clock.

## Not done / carried

- DND provider integration (Q-02) — interface and dispatcher hook exist; no vendor.
- Extension deploy, theme-editor placement and Plus checkout editor setup — human, after Q-08.
- Provider-checkout ingestion (GoKwik etc., E-14, Q-09) — Phase 5.
- `reactivation` has attempt caps and a purpose but no trigger or template — not in Phase 4 scope.
- Terraform unchanged this phase; not re-validated (disk space on the dev machine).
