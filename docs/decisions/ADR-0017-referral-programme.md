# ADR-0017 — Referral programme: the rules are decided, the reward is not

**Status:** proposed — the mechanism and anti-abuse rules are built and tested; the reward amount
is a product decision still to be made (invariant 11: no billing change without one)
**Date:** 28 Sep 2026
**Deciders:** Founder (mechanism drafted by agent; P7-GTM-1)
**Invariants touched:** 11 (billing), 15 (tenant isolation)

## Context

Merchants hear about tools from other merchants. A referral programme rewards that: store A gives
its code to store B, B enters it when it joins, and once B is a real, paying customer, A gets a
credit on its bill.

A referral reward is money, so invariant 11 applies: the amount, who earns it and when need a
written product decision. This ADR records everything else so that the decision is one number
per currency.

## Decision — what is built

**Codes.** Every merchant has one 8-character code (no `0/O`, `1/I/L`, so it survives being read
over the phone), shown on the dashboard's Referrals page.

**Claiming.** Only the referred merchant can create a referral, by entering the code — owners only,
once, rate-limited to 10 tries an hour. The database function `claim_referral()` refuses:

| Refusal | Why |
|---|---|
| unknown code | — |
| your own code | — |
| already referred | a merchant names one referrer, once, ever |
| account older than **30 days** | a referral is how you joined, not a discount to claim later |
| an owner of the referrer is also a user here | self-referral through a second account |
| referrer suspended or uninstalled | — |

Both merchants can see the referral; the referrer sees the referred store's name as it was when
the code was entered, and the page tells the new merchant so before they enter it.

**Qualifying.** The billing worker's nightly run moves a referral to `qualified` once the referred
merchant has been paying (at least one real charge in the ledger) and has stayed **60 days**. If it
uninstalls or is suspended first, the referral is `void`. Every transition is audited on both
merchants.

**Rewarding.** A qualified referral becomes `rewarded` when a reward exists for the referrer's
currency: a `credit` row in `billing_ledger` whose `ref` is the referral id, so the ledger's unique
index makes a second credit impossible. For Shopify-billed referrers the credit is applied in the
Partner Dashboard, as dispute credits already are.

## Decision — what is not decided

**The reward: `REFERRAL_TERMS.reward = null`** in `pipeline/src/referrals.ts`. Until it is set,
referrals are recorded and qualified, and nothing is credited. Nothing is lost: when a reward is
set, the next nightly run credits every referral that has already qualified.

To decide, and to switch it on, in one reviewed pull request:

1. The amount per currency, in minor units — for example `{ INR: 100000, USD: 5000 }` for ₹1,000
   and $50.
2. Whether a reward is capped per referrer per year.
3. Whether the **referred** merchant also gets something (a first-month discount is common). Not
   built: it would be a second credit, on the other account, and needs the same decision.
4. Update this ADR to **accepted** with those numbers, and set `REFERRAL_TERMS.reward`.

The terms are code constants rather than configuration on purpose: changing what the product pays
out should be a reviewed change with its reason attached, never a variable edited on a server.

## Consequences

- Referrals made today count later: turning the reward on pays everything already qualified.
- The 30-day window, the 60-day qualification and the same-owner check are guesses at a sensible
  default. Change them in the same pull request as the reward if the decision says otherwise.
- A referral is not a contract. The terms of service should say the programme may change; that
  wording is a counsel item alongside the other legal pages.
