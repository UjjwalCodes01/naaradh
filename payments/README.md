# payments

Clients for the two payment providers we bill directly through, written over `fetch` with no
vendor SDK.

- **`src/razorpay.ts`** — subscriptions and add-ons for Indian merchants who pay in rupees.
- **`src/stripe.ts`** — Checkout sessions, subscriptions and invoice items for merchants who pay
  in dollars.

Both also verify that provider's webhook signatures. Shopify-installed merchants are billed
through Shopify instead (`shopify-sdk/`), which the App Store requires.

**What does NOT live here:** what to charge. Plans, metering and the ledger are in
`pipeline/src/billing/`; a provider webhook is only a hint, and the worker re-fetches the
subscription before changing anything (ADR-0008).
