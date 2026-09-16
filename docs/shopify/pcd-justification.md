# Protected customer data — Level 2 request (P2-SHOP-6)

The text and evidence for the Partner Dashboard request. A human submits it (CLAUDE.md: no
Partner Dashboard changes by agents). Keep it in step with `packages/shopify-sdk/src/scopes.ts`
and `apps/shopify/shopify.app.toml`.

## Fields requested and why

| Field | Why the app needs it | Where it is used |
|---|---|---|
| Customer **phone** | To place the order-confirmation call the merchant switched on, and to recognise a caller on the merchant's support line (caller ID) so the agent can discuss that caller's own orders. | `orders/create` → `call_intents` (encrypted), order cache for inbound lookups |
| Customer **name** | To greet the customer by name on the call. | Rendered into the call only; never logged |
| Shipping **pincode** | Second factor when a caller verifies an order by order number + pincode. | Stored as a keyed hash (`orders.pincode_hash`), never in clear |
| **Abandoned-checkout** phone, first name, line-item titles and total (`read_checkouts`) | To place the abandoned-checkout recovery call the merchant switched on, and only for shoppers who ticked Naaradh's own consent box at checkout or in the cart. | `checkouts/create|update` → `checkouts` (phone hashed + encrypted on the contact), consent ledger with the wording version (ADR-0010) |

Not requested: email address, full shipping address (an address change becomes a merchant
ticket; Naaradh never writes an address — Q-19). Checkout rows deliberately hold **no** email,
address or `abandoned_checkout_url` (that URL is a bearer link to the shopper's cart), and the
phone link is stripped after 30 days; Shopify's `buyer_accepts_marketing` and SMS-consent fields
are never read — consent for a call comes only from Naaradh's own checkbox (E-13, E-107).

## Scopes (minimum)

`read_orders, write_orders, read_customers, read_checkouts, read_fulfillments, read_locales` —
reasons per scope in `packages/shopify-sdk/src/scopes.ts`. `write_customers` is deliberately
not requested (no code writes a customer; Q-07).

## Level 1 and Level 2 requirements — how Naaradh meets them

| Requirement | Evidence |
|---|---|
| Process only the minimum personal data | Webhook parsers keep phone, name, pincode, order ref, amount, gateway; everything else is dropped (`packages/shopify-sdk/src/webhooks.ts`). |
| Tell merchants what is processed and why | Privacy policy and DPA (naaradh.com/privacy, /dpa); in-app setup screen. |
| Limit use to the stated purpose | Calls only for use cases the merchant enabled; every call passes the compliance gate (invariant 1). |
| Respect consent decisions | Promotional calls need a recorded consent row from Naaradh's own checkbox, under 7 days old in India, revoked the moment the box is unticked; opt-outs are absolute suppressions (invariants 5, 6; ADR-0010). |
| Opt-out of data processing | Do-not-call page for anyone; verbal opt-out on any call; erasure requests. |
| Retention | Recordings/transcripts 30–365 days by merchant setting (default 90); order cache 180 days; abandoned-checkout phone links 30 days; `shop/redact` purges the store's data (E-48). |
| Encryption at rest and in transit | TLS everywhere; phone numbers RSA-OAEP encrypted + HMAC hashed; recordings under CMEK; Shopify tokens AES-256-GCM (ADR-0007); database encrypted at rest by the provider. |
| Test and production data separated | Separate GCP projects and Partner apps per environment (infra/, P2-SHOP-8); fake phone ranges only in tests (lint:pii). |
| Data-loss prevention / access control | Postgres row-level security per merchant; masked numbers in every UI; the dashboard and Shopify app hold no decryption key. |
| Staff access limited and logged | Staff console behind Identity-Aware Proxy, staff allow-list; every recording/transcript access and staff action in `audit_log`, visible to the merchant (access log). |
| Strong passwords / MFA for staff | Google Workspace accounts with enforced 2-step verification gate IAP. |
| Audit logs | `audit_log` (append-only, trigger-enforced) for every state change and data access. |
| Security incident response policy | `docs/runbooks/` (incident response plan: SPEC §13, [LEGAL] draft pending). |
| Mandatory compliance webhooks | `customers/data_request`, `customers/redact`, `shop/redact` → apps/hooks (401 on bad HMAC) → erasure workflow (P2-CMP-3). |

## Before submitting

- [ ] Privacy policy and DPA reviewed by counsel (drafts are live, marked as drafts).
- [ ] Incident response plan written and linked.
- [ ] Sub-processor list names the chosen voice engine and telephony provider.
- [ ] Q-16 (database in Singapore) answered or disclosed as-is.
