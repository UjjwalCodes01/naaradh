# ADR-0010 — Promotional calling: abandoned cart, post-delivery feedback, A/B scripts, recovery attribution

**Status:** accepted (billing of recoveries: **proposed**, see decision 9)
**Date:** 2026-09-15
**Deciders:** Founder (implemented by agent, PLAN Phase 4 — P4-SHOP-1…3, P4-CMP-1…2, P4-WEB-1…2, P4-BILL-1, P4-OPS-1)
**Invariants touched:** 1, 2, 3, 5, 6, 7, 8, 10, 11 (unchanged), 12, 15
**Edge cases:** E-04, E-06, E-08, E-13, E-14, E-29, E-40, E-42, E-48, E-71 and the new E-100…E-119 below

## Context

Phase 4 turns on the first promotional purposes. Promotional calls carry the regulatory risk
that ends a telecom business (five valid complaints in ten days can blacklist every resource,
SPEC §4.1.1), so every choice below errs towards *not* calling. The gate already required a
consent row, a linked DLT principal entity and a DND scrub for promotional purposes; this ADR
records what Phase 4 adds and why.

## Decisions

1. **Abandoned checkouts are cached, then swept — not turned into intents on arrival.**
   `checkouts/create|update` upsert a `checkouts` row (newest `updated_at` wins). A sweep in the
   reconcile worker creates the `abandoned_cart` intent only when the checkout has been idle
   45 minutes, is under 24 hours old, has a phone, is not completed and was not converted into
   an order. This makes the 45-minute debounce, late phone entry, phone changes and completion
   all fall out of one rule instead of being patched into a scheduled intent.

2. **Consent comes only from our own checkbox, never from Shopify marketing flags (E-13, Q-08).**
   The checkout UI extension (Shopify Plus stores) and a cart-page theme block (every other
   plan) write the attribute `naaradh_call_consent = <wording version>`. The consumer records a
   ledger grant (source `checkout`, purpose `promotional`, the wording version, the checkout as
   external ref) only when the version is one Naaradh published (`CONSENT_WORDINGS`); an unknown
   value is audited and ignored. `buyer_accepts_marketing` and SMS-consent fields are never read.
   An attribute that disappears on a later update of the same checkout revokes the grant.
   The wording is a draft pending counsel (`TODO_LEGAL`). The same attribute on an **order**
   (the cart block's attribute carries into the order; one-click checkouts send no checkout
   webhooks) records the same grant, once per order. Non-Plus stores get the cart block because
   the contact-step checkout extension is Plus-only (Q-22).

3. **One promotional call per phone per tenant per 7 days, one attempt per checkout.** The gate
   gains `attempts:promotional_cooldown` (any promotional use case, dialled attempts only) and
   per-use-case attempt limits (`abandoned_cart` 1, `feedback` 1, `reactivation` 1). The
   results path exhausts instead of scheduling a retry the gate would refuse.

4. **Promotional calls in India need a registered DLT content template.** The approved script
   must carry `dlt_template_id`; otherwise `script:dlt_template_missing`. The template id is
   copied onto the attempt (`call_attempts.dlt_template_id`) so every call record maps to the
   template a TSP or TRAI will ask about ("template ID on CDR mapping").

5. **A complaint about a promotional call pauses that tenant's promotional calling.** Complaints
   now record the purpose and use case of the attributed call. A complaint attributed to a
   promotional call sets `tenants.promotional_paused_at` (gate reason
   `tenant:promotional_paused`), audits it, emits `promotional.paused` and emails the merchant;
   transactional and service calls continue. Only staff lift it (console). It is a tenant column
   the app role cannot write, not a `flags` row — merchants can edit their own flags. The E-05 counters are unchanged — the regulator
   counts every complaint, so we do.

6. **DND stays fail-closed, and is scrubbed at dial time.** Promotional calls are refused while
   the scrub result is `unknown`, which is the permanent result until a TSP scrub provider is
   contracted (Q-02). Promotional calling therefore cannot go live before that contract, by
   construction. The provider needs the plaintext number, which only the dispatcher can decrypt,
   so the dispatcher scrubs a promotional intent just before the gate when the 24-hour cache is
   empty. A definite answer is cached; a provider error or `unknown` is not (the next attempt asks
   again instead of being blocked for a day).

7. **Post-delivery feedback** is a promotional use case (invariant 5): created when a
   fulfilment reports `delivered`, dialled no earlier than 24 hours and no later than 72 hours
   after delivery, skipped for cancelled, returned or test orders. With India's 7-day consent
   validity most checkout consents will have expired by then; the gate refuses those calls
   (`consent:expired`) and the dashboard says so. That is the rule, not a bug.

8. **A/B scripts** are two approved versions of the same use case and locale, arms `A` and `B`.
   The arm is chosen by a stable hash of the intent id, so a retry hears the same script. A test
   starts only from an approved champion and a validated challenger, and ends by retiring one
   arm; approving another version during a test is refused. The metrics view reports per arm
   and declares no leader below 100 answered calls per arm.

9. **Recovery attribution is measured, not billed (P4-BILL-1 — proposed).** An order from the
   same phone (or the same checkout) within 24 hours after an abandoned-cart call that reached a
   human is recorded in `attributions` (last touch, one per order, reversed if the order is
   cancelled). The billable outcome set (invariant 11) is **unchanged**: a recovery is not
   billed until the founder records the pricing decision and the Terms addendum (ADR-0003 /
   P4-GTM-3). The call outcome for "I'll complete the order" is `will_complete`; the word
   `recovered` is reserved for the attribution.

10. **Naaradh sends no SMS or WhatsApp.** A customer who wants the checkout link produces the
    merchant event `checkout.recovery_requested`; the merchant's own messaging (Shopify's
    abandoned-checkout email, their WhatsApp provider, Flow) sends it. Sending messages would
    need DLT SMS templates and a sender ID — out of scope until Q-21 is answered.

11. **Weekly QA sampling (P4-OPS-1).** Every Monday a deterministic 2% of the previous week's
    human-answered calls per tenant (at least one, at most 20) is queued for staff review in the
    console with a fixed rubric. Reading a transcript there is audited as staff. Extraction
    accuracy per tenant comes from these reviews.

## New edge cases

| Id | Case | Behaviour |
|---|---|---|
| E-100 | Checkout created without a phone, phone added later | Row updated; swept once idle 45 min with a phone |
| E-101 | Customer keeps editing the checkout | Every update resets the 45-minute idle clock; the 24-hour expiry never moves |
| E-102 | Checkout completed, or an order placed from the same phone, before the call | Never swept; an intent already scheduled is cancelled (`checkout_completed` / `order_placed`) |
| E-103 | Order placed while the recovery call is ringing | Intent cancelled; the live attempt is superseded (E-40), not billed |
| E-104 | Webhooks out of order (update before create, old update after new) | Newest `updated_at` wins; a completed checkout never reopens |
| E-105 | Checkbox ticked, then unticked on the same checkout | Grant recorded, then revoked |
| E-106 | Consent attribute with a wording version we never published | Not recorded; audited (`consent.unknown_wording`) |
| E-107 | Shopify marketing consent true, our checkbox absent | No consent; checkout skipped `consent:missing` |
| E-108 | Several abandoned checkouts from one phone | One call per phone per 7 days; the rest skipped `recently_called` |
| E-109 | Abandoned at 20:40 IST | Due 21:25 — window closed; promotional waits for 09:00 if still inside 24 h |
| E-110 | Checkout older than 24 h when first seen (late webhook, reinstall) | Never swept |
| E-111 | Store on a one-click checkout (GoKwik etc., E-14) | No checkout webhooks; nothing to sweep; the dashboard shows zero checkouts |
| E-112 | Promotional script without a DLT template id | `script:dlt_template_missing` |
| E-113 | Complaint about a promotional call | Tenant promotional paused; staff lift; counters unchanged |
| E-114 | Delivered event for a cancelled, returned or test order | No feedback intent |
| E-115 | Duplicate delivered events | One feedback intent (idempotency on order + use case) |
| E-116 | A/B arm retired mid-test | Remaining arm serves every call; attempts keep the script id they ran |
| E-117 | Order after a call that did not reach a human (no answer, voicemail) | Not attributed |
| E-118 | Attributed order cancelled later | Attribution reversed; revenue excluded |
| E-119 | Erasure / shop redact | Checkout rows and attributions lose the phone hash; aggregate counts stay |

## Consequences

- Promotional calling needs, in order: DLT registration and PE linkage, a TSP DND scrub
  provider, a lawyer-approved consent wording, the consent extension deployed, an approved
  script with a DLT template id, and the use case switched on. The gate refuses each missing
  piece with a reason the merchant can read.
- Checkout rows hold no name, email, address or recovery URL — only the phone hash, a contact
  link, the cart summary and value, and timestamps. The recovery URL is a bearer link to the
  customer's cart and is never stored. After `CHECKOUT_RETENTION_DAYS` (30) the retention worker
  strips the phone hash, contact and cart summary; counts stay for the Results page.
- Only order use cases (`cod_confirm`, `delivery_reschedule`) write back to the store. A
  promotional outcome changes nothing in Shopify.
- Open questions this depends on: Q-02 (DND provider), Q-08/Q-22 (wording, cart block),
  Q-21 (who sends the link), Q-23 (voice content templates), Q-24 (pricing a recovery).
- The QA queue and promotional-pause flag are staff-only; merchants see the pause and its
  reason on their dashboard banner.
