# Billing postings — charges not reaching Shopify / Razorpay, capped tenants, reconciliation deltas

**How money moves (ADR-0008):** a billable outcome or an inbound call writes a `billing_ledger` row (append-only; the plan's allowance first at ₹0, then the plan price). The **billing worker** (`WORKER=billing` or `all`, service role) turns chargeable rows into `billing_postings` and sends them:

| Provider | Posting | Idempotency |
|---|---|---|
| Shopify | one usage record per ledger row, against the subscription's usage line | `idempotencyKey = ledger id` — Shopify returns the original record on reuse |
| Razorpay | one add-on per tenant per **closed** month (net of credits), charged on the next invoice | `rzp:<tenant>:<period>` unique in Postgres; Razorpay has no key (see "double add-on") |
| manual | none — finance invoices from the ledger | — |

Subscription webhooks (`app_subscriptions/update`, Razorpay `subscription.*`) are **hints**: the worker re-fetches the subscription and only the fetched state changes `billing_subscriptions` and `tenants.billing_status`.

## Look at it

```sql
select id, provider, status, attempts, amount_minor, currency, period, last_error, next_attempt_at
from billing_postings where tenant_id = '<ten_…>' order by created_at desc limit 20;
select billing_status, billing_grace_until, billing_provider, plan_code, inbound_plan_code from tenants where id = '<ten_…>';
```

## Capped (`billing_status = capped`, E-61)

The merchant's usage reached the cap they set in Shopify. The gate refuses outbound dials (`billing:capped`); inbound calls forward to the merchant's own line. The refused charge sits as a `capped` posting.

- Nothing is lost: when the merchant raises the cap (Shopify → Naaradh app → Billing → raise cap, approved in admin) or a new 30-day interval starts, the next subscription sync sets the tenant `active` and puts the capped postings back in the queue.
- To force a sync after the merchant says they raised it: re-deliver their last `app_subscriptions/update` webhook, or wait for the nightly reconciliation (02:00 IST).

## Frozen (`billing_status = frozen`, E-50)

Shopify FROZEN or Razorpay pending/halted/paused: payment trouble. Dispatch continues for **3 days** (`billing_grace_until`), then the gate refuses `billing:frozen`. The grace is not extended by repeated webhooks. Contact the merchant before the grace ends.

## Failed postings

| `last_error` | Meaning | Action |
|---|---|---|
| `ShopifyRetryableError` / `RazorpayRetryableError` | provider down or throttling | automatic retries (2, 4, 8 … 60 min, 8 attempts) |
| `no_active_subscription` | the merchant has no active subscription at that provider | retried hourly; once they subscribe, the posting moves to the new subscription |
| `ShopifyAuthError` / `StoreNotConnectedError` | token revoked, app reinstalled | merchant reopens the app; then `update billing_postings set status='pending', next_attempt_at=now(), attempts=0 where id=…` |
| `ShopifyUserError` (not over cap) | Shopify refused the charge | read the message; usually a cancelled subscription — confirm and re-point or write off with finance |
| `RazorpayError 400` | bad subscription / add-on | check the subscription in the Razorpay dashboard |

## Reconciliation delta ("billing reconciliation delta (must be 0)")

Nightly, for each active Shopify subscription: our posted total in the current 30-day interval vs Shopify's `balanceUsed`.

- Ours > Shopify: a usage record we think we posted is not there. Find postings `posted` in the interval and compare `provider_ref` with Shopify's usage records (Partner Dashboard → app → merchant). Re-queue any that are missing (the idempotency key makes it safe).
- Shopify > ours: someone created a charge outside Naaradh, or a posting's DB update was lost after Shopify accepted it (the next re-post returns the original record, so re-queueing is safe here too).

## Double add-on (Razorpay)

A crash after Razorpay accepted an add-on but before the posting was marked `posted` can post the month twice on retry. Razorpay dashboard → subscription → add-ons: if two add-ons exist for the same month, delete the later one before the invoice is generated (or credit it). Record what you did on the posting (`last_error` note) and in the audit channel.

## Margin alert ("gross margin below 40% (E-33)")

Daily per tenant: usage billed + a day of platform fee vs vendor cost. Usually a mis-set enterprise override (`tenants.billing_overrides`) or unusually long calls. Review with the founder; overrides are service-role only.
