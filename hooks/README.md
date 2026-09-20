# hooks

Every webhook that arrives from somebody else — `hooks.naaradh.com`. Shopify, the voice vendor,
Razorpay, Stripe, and the region directory other deployments push to us.

It does exactly four things, in order, and nothing else (AGENTS §3):

1. **verify** the signature over the raw bytes (invariant 9) — a bad one is 401, never parsed;
2. **dedupe** on the sender's event id (`webhook_events`, invariant 10);
3. **publish** to Pub/Sub for a worker to handle;
4. **answer 200** in under 800 ms, because Shopify retries and eventually unsubscribes.

**What does NOT live here:** any decision. A webhook is only a hint — the worker that picks it up
re-fetches from the vendor before writing an outcome or a charge (E-23). If you are adding
business logic to this folder, it belongs in `workers/`.

Env: `pnpm env:list hooks`.
