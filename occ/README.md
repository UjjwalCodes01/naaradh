# occ

One-click-checkout providers behind one port: **GoKwik, Shiprocket Checkout, Razorpay Magic and
Cashfree One Click Checkout** (E-14, ticket P5-OCC-2).

**Why it exists:** a merchant who replaces Shopify's checkout gets no `checkouts/create|update`
webhooks at all, so Shopify can no longer tell us a cart was abandoned. The provider has to. This
package authenticates that request and maps its body to the same cart shape a Shopify checkout
produces — and then gets out of the way.

**What lives here:** per-provider payload mapping (`cashfree.ts`, `razorpay-magic.ts`,
`generic-cart.ts`), the URL tag and signature verification (`verify.ts`), and the normalised cart
(`types.ts`).

**What does NOT live here:** whether anyone gets called. That is `@naaradh/pipeline`
(`recordCheckout`, `sweepAbandonedCheckouts`) and the gate, unchanged: the 45-minute idle
debounce, the 24-hour expiry, one call per cart, the DND scrub, the calling window — and consent,
because `abandoned_cart` is promotional and needs a row in the ledger (invariant 5). An OCC cart
cannot be called on looser terms than a Shopify one, and no body arriving here can create consent.

## How a merchant is connected

1. The owner turns the provider on in **Dashboard → Developers → One-click checkout**.
2. They paste the URL and secret shown there into the provider's dashboard.
3. `hooks` verifies both on every delivery; `workers` (intents) records the cart.

```
https://hooks.naaradh.com/occ/<provider>/<tenant_id>.<tag>
tag    = HMAC-SHA256(PROVIDER_WEBHOOK_KEY, "occ:<provider>:<tenant_id>")   (first 32 hex)
secret = HMAC-SHA256(PROVIDER_WEBHOOK_KEY, "occ-secret:<provider>:<tenant_id>")
```

Neither is stored: both are derived from `PROVIDER_WEBHOOK_KEY`, so there is no per-tenant secret in
the database, and rotating that one key re-issues every merchant's URL together. Unset the key and
every `/occ` route answers 404 — the correct state until a provider is contracted (P5-OCC-1).

## Authentication, and why it is two layers

| Provider | Signs? | Default policy |
|---|---|---|
| Cashfree | Yes — `x-webhook-signature` over `timestamp + body`, with a secret specific to the abandoned-checkout webhook | `required` |
| Razorpay Magic | Not documented for this webhook | `optional` |
| GoKwik | Not published | `optional` |
| Shiprocket | Not published | `optional` |

The URL tag is checked first, always, before the body is parsed (invariant 9), and it binds the
delivery to exactly one tenant. The provider's signature is checked on top where there is one. A
signature that is **present and wrong is always a rejection**, under either policy — otherwise
"unsigned is allowed here" would be a downgrade an attacker could choose.

**Configuration may tighten verification, never weaken it** (`effectiveSignaturePolicy`). A
merchant can require signatures from a provider that publishes no scheme; nothing — not the
dashboard, not a hand-edited `integrations.metadata` row — can take Cashfree below `required`,
because that would leave the URL as the only credential for the one provider that signs.

## `[VERIFY]` before the first live merchant

Cashfree's and Razorpay Magic's payloads are mapped from their published references (read
Sep 2026); Cashfree's signing algorithm and GoKwik's and Shiprocket's payloads are not published
at all. Every one of those is marked `[VERIFY]` in the source. The first recorded delivery from
each provider replaces the tolerant mapping with an exact schema — the same discipline the engine
adapters follow. Until then the rule holds: read what we recognise, ignore the rest, never guess a
phone number.
