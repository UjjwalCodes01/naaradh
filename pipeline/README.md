# pipeline

The business operations that `api/`, `voice/` and `workers/` all need, so the three of them
cannot each implement "cancel an order" slightly differently.

**What lives here:** contacts and phone hashing, call intents, the order cache, tickets, agent
actions, knowledge articles, the consent and suppression writes, billing (plans, metering, the
ledger, Razorpay/Stripe subscriptions, postings), the dashboard's read models, appointments,
promotional-calling rules, privacy and erasure, and the region directory.

**What does NOT live here:** HTTP (that is `api/`), scheduling and dialling (`workers/`), whether
a call is allowed (`compliance/`), and the SQL schema itself (`db/`).

Everything here takes a transaction and runs inside a tenant context, so row-level security
applies (invariant 15).
