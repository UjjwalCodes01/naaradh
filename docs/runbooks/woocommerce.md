# WooCommerce plugin — nothing is happening

The plugin (`plugins/woocommerce`, ADR-0011 §3) reports orders and carts to `api.naaradh.com` from the merchant's server and writes results back as order notes. It never cancels or edits an order.

## First checks, in order

1. **WooCommerce → Settings → Naaradh.** The top of the page lists what is wrong: no API key, cart recovery on without consent wording, the last API error, a hidden phone field.
2. **The key's scopes.** It needs `intents:create`, `orders:write`, `carts:write`. A 401/403 from us shows up as an admin notice there.
3. **WooCommerce → Status → Logs**, source `naaradh`: every failed call is logged with the path and status. No log lines at all means the plugin is not being reached — check that WooCommerce is active and the store is not in maintenance mode.
4. **Our side:**

```sql
-- orders arriving from this merchant
select external_id, name, payment_kind, source_updated_at from orders
where tenant_id = '<ten_…>' and source = 'api' order by source_updated_at desc limit 10;

-- carts, and what was decided about each
select external_id, status, skip_reason, consent_wording, source_created_at from checkouts
where tenant_id = '<ten_…>' and source = 'api' order by source_created_at desc limit 10;
```

## "No confirmation calls"

- The plugin only calls for **cash-on-delivery** orders (`payment_method = cod`) and only when that setting is on.
- No phone on the order → nothing to call. E-127: a checkout with the phone field hidden can never work.
- Otherwise the order has an order note saying what Naaradh answered (`scheduled`, `gated:<reason>`, `skipped:<reason>`) — that note is the gate's own words.

## "No cart recovery calls"

Carts are reported only when **all** of these hold: cart recovery on, consent wording and version set, the shopper gave a phone number, and the shopper ticked the box. Then the ordinary rules apply (ADR-0010): idle 45 minutes, under 24 hours, a live consent, one promotional call per number per 7 days, DND scrub, DLT template. `promotional-calling.md` explains each refusal.

A cart with `consent_wording` null in the query above is a shopper who did not tick the box (E-121) — the funnel counts it, nothing calls it.

## "Results are not appearing as order notes"

1. The merchant must register a webhook in Naaradh pointing at `https://<store>/wp-json/naaradh/v1/events` and paste its signing secret into the plugin settings.
2. Check delivery health:

```sql
select event_type, status, attempts, last_error, next_attempt_at
from merchant_webhook_deliveries where tenant_id = '<ten_…>' order by created_at desc limit 20;
```

`failed` with a 401 means the secret in the plugin does not match the webhook's secret. Dead-lettered after 5 attempts (E-124) — fix the secret, then ask the merchant to re-check; past events are not replayed automatically.

3. A 401 in the store's own logs with "bad signature" is E-125 working: either the secret is wrong or something forged a request.

## Upgrading or removing

The plugin stores only its options plus two order meta keys (the consent wording version and the last event ids it acted on). Deactivating stops everything at once; uninstalling deletes the options and leaves order notes and meta alone — they are the merchant's records.
