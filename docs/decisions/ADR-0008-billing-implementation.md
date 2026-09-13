# ADR-0008 — Billing: plan catalogue, included allowances, provider postings

**Status:** accepted (prices remain `[DECISION — founder]`, Q-17)
**Date:** 2026-09-12
**Deciders:** Founder (implemented by agent, per PLAN P2-SHOP-3, P2-BILL-1…3)
**Invariants touched:** 11 (unchanged — WHAT is billable; this ADR is about HOW MUCH and WHERE), 10 (idempotent charges)

## Context

SPEC §2.2's price book has a platform fee **with included outcomes / minutes** and a price per
extra. Phase 1 wrote every billable outbound outcome to the ledger at the per-outcome price — no
allowance — while inbound minutes already had one. Nothing posted ledger rows to a provider, and
`billing_ledger` is append-only, so "posted" cannot be a column update on it.

Providers differ: **Shopify** (mandatory for App Store merchants) takes a recurring charge plus
usage records against a capped usage line, idempotent by key, in the merchant's billing currency
(INR where Shopify supports local billing, else USD). **Razorpay** (direct Indian merchants) has
plans + subscriptions; usage is added as an **add-on** on the subscription, charged on the next
invoice, with no idempotency key.

## Decision

1. **One plan catalogue** (`packages/pipeline/src/billing/plans.ts`) — outbound and inbound plans,
   each with fee, included units and per-extra price **in INR and USD**. Tenant `settings` may
   override included units and unit prices (enterprise). USD prices for Indian plans are
   `[DECISION — founder]` derived at ≈ ₹84/$ and rounded.
2. **Included allowance at ledger time, for both directions.** `meterOutcome` mirrors
   `meterInboundCall`: per tenant per period, under an advisory lock, the first N billable outcomes
   are ledger rows at unit 0 (the idempotency marker and the usage record), the rest at the plan
   price. The billable *definition* (invariant 11) is untouched.
3. **`billing_postings` is the outbox to providers** — the ledger stays append-only. A posting names
   the ledger rows it covers, the provider amount in the provider's currency, an idempotency key,
   and its state (`pending → posted | capped | failed | skipped`).
   - Shopify: one posting per chargeable ledger row, `appUsageRecordCreate` with
     `idempotencyKey = ledger id` (Shopify returns the original record on reuse).
   - Razorpay: one posting per tenant per **closed** period — an add-on for the period's overage,
     key `tenant:period`, created only after the period ends.
   - `manual`: postings are `skipped`; finance invoices from the ledger.
4. **Capped (E-61):** a failed Shopify usage record is checked against the subscription's
   `balanceUsed`/`cappedAmount`; over the cap → posting `capped`, tenant `billing_status = capped`
   (gate refuses outbound, admission forwards inbound), merchant event + notification. Raising the
   cap (`appSubscriptionLineItemUpdate`, merchant approves) re-activates and re-queues capped postings.
5. **Subscription webhooks are hints.** `app_subscriptions/update` and Razorpay `subscription.*`
   trigger a **re-fetch** of the subscription from the provider; only the fetched state changes
   `billing_subscriptions` and `tenants.billing_status` (service role). FROZEN / pending /
   halted → `frozen` with a 3-day grace (E-50); CANCELLED / DECLINED / EXPIRED / completed →
   `cancelled` when it is the tenant's current subscription.
6. **Disputes (E-62):** open within 7 days of the outcome; an accepted dispute writes a `credit`
   ledger row (negative) and, for Shopify, a manual refund in the Partner Dashboard (there is no
   app-credit mutation) — recorded on the dispute.

## Consequences

- The e2e expectation "first outcome bills ₹8" becomes "first outcome is included (₹0)".
- Residual risk: a crash between a Razorpay add-on API success and the DB update can double-post
  one monthly add-on; the nightly reconciliation compares posted totals with provider totals and
  the runbook covers the correction.
