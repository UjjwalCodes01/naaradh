# Billing dispute — a merchant says an outcome should not have been charged (E-62)

**Rules:** only a **billed** outcome that was **charged** (beyond the plan allowance) can be disputed, within **7 days** of billing, once per outcome. The billable definition itself (invariant 11) is not negotiable per case — a dispute asks whether *this call* really met it (e.g. the "confirmation" was a wrong number, or a machine).

## Evidence bundle (staff console → dispute)

For the disputed outcome gather, and attach to your resolution note:

1. The recording (signed URL, access audited) and transcript.
2. The extraction (`call_outcomes.extracted`, confidence) and the end reason.
3. Timestamps: `answered_at`, `ai_disclosed_at`, `recording_disclosed_at`, `ended_at`, `human_speech_sec`.
4. The gate trace of the intent (was it transactional, inside the window).

## Decide

- **Accept** when the call did not meet the billable definition (not a human, not a definitive outcome, wrong person) or a Naaradh defect caused the outcome. Staff console → Accept, with a written resolution (≥ 10 characters). This writes a **negative `credit` ledger row** equal to the charge (the ledger is append-only; the billed outcome stays frozen).
- **Reject** when the evidence shows a human gave a definitive answer. Write why, quoting the transcript line.

## Refund the money

| Provider | How |
|---|---|
| Razorpay | automatic — the credit nets out of the next monthly add-on |
| Shopify | **manual**: there is no app-credit mutation. Partner Dashboard → Apps → Naaradh → the merchant → Refund the usage charge (amount = the credit). Note the refund reference in the dispute resolution. |
| manual | finance applies the credit on the next invoice |

## Patterns

Three accepted disputes for the same reason in a week → it is not a dispute, it is a bug or a script problem: open an engineering ticket (extraction threshold, AMD mode, script wording) and link the disputes.
