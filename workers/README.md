# workers

Pub/Sub consumers and Cloud Run Jobs. **Status:** not implemented — tickets P1-CORE-4 / 6 / 7 / 8.

| Worker | Job | Ticket |
|---|---|---|
| `intents-consumer` | source events → `call_intents` (idempotency keys, `not_before`/`not_after`, variable sanitiser) | P1-CORE-4 |
| `dispatcher` | **gate → placeCall → `call_attempts`**. The only thing in the system allowed to dial. | P1-CORE-6 |
| `results-consumer` | engine events → attempts/outcomes → write-backs → billing events | P1-CORE-7 |
| `billing-meter` | billing events → Shopify usage / Razorpay / Stripe; nightly reconciliation | P2-BILL-1 |
| `reconcile` | hourly Shopify order reconciliation; stuck-attempt poller; concurrency leak repair (E-21, E-53) | P1-CORE-8 |
| `retention` | recordings/transcripts lifecycle; erasure requests | P2-CMP-3/4 |
| `complaints` | complaint intake → rolling counters → auto-pause at 3, global kill at 5 (E-05) | P2-CMP-1 |

The dispatcher is the single writer to `call_attempts`, and it writes the row **before** calling the
engine. If the engine returns an id but the HTTP call times out, the attempt is marked `UNCERTAIN`
and polled with `fetchCall` — never blindly retried, because a call may already be ringing.
