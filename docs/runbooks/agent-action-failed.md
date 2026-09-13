# Agent action failed — a confirmed cancellation did not reach the store

**Symptom:** a ticket with priority 90 and summary "A caller confirmed cancelling order … could not be cancelled automatically (…)"; `audit_log` has `order.cancel_handed_over`; or `order_actions` rows sitting in `failed`.

## How the path works

1. On the call, the caller asked to cancel; the agent read the order back; the caller said yes; the agent sent the single-use token (E-84). `agent_actions` has the step-1 row (`awaiting_confirmation`) and the step-2 row (`approved`, `parent_action_id` → step 1).
2. Step 2 inserted an `order_actions` row (`pending`). Any queued COD confirmation call for that order was cancelled (E-97).
3. The **actions worker** (`WORKER=actions` or `all`) claims due rows with `SKIP LOCKED`, re-checks every guard, and calls the store:
   - order already cancelled → `done`
   - order shipped since, profile's `agent_cancel_enabled` switched off since, order erased, or no active store connection → `dead` + ticket for a person
   - store error → `failed`, retried after 2, 4, 8, 16 minutes; after 5 attempts → `dead` + ticket
   - success → `done`, `orders.cancelled_at` set, merchant event `order.cancelled_by_agent`
4. API/WooCommerce merchants (order `source` ≠ `shopify`) receive `order.cancellation_requested` (mode `agent_cancel`) and cancel it themselves; the row is marked `done` with audit `order.cancel_delegated`.

## Look at it

```bash
psql "$DATABASE_SERVICE_URL" -c "
  select oa.id, oa.status, oa.attempts, oa.last_error, oa.next_attempt_at, o.name, o.fulfillment_status, o.cancelled_at
  from order_actions oa join orders o on o.id = oa.order_id
  where oa.tenant_id = '<ten_…>' and oa.status in ('failed','dead','executing')
  order by oa.updated_at desc"
```

- `last_error = stale_executing` → a worker died mid-call; the row was handed back to the queue automatically after 5 minutes. Check whether the store actually cancelled it before the crash (Shopify admin) — the retry is safe because an already-cancelled order is marked `done` without a second call.
- `store_error: …` → read the message. Scope revoked / app uninstalled → the merchant must reconnect; token expired → the Shopify client refreshes it; 5xx → Shopify incident, retries will catch it.

## Resolve

- **Dead with a ticket:** a person at the merchant cancels (or arranges the return) in their store and resolves the ticket: `POST /v1/tickets/:id/resolve`. Do not flip the `order_actions` row back to `pending` by hand unless the blocker is gone *and* the merchant agrees — the caller was told "the store will send you a confirmation", and the ticket is how that promise is kept.
- **Never** insert `order_actions` rows by hand. Every row must point at an `agent_actions` approval; that pair is the evidence the customer asked twice.

## Related

- Invariant 14 (as amended by ADR-0006): agent cancellation only when the profile's `agent_cancel_enabled` is on, the caller's identity covers the order, the order is COD, unfulfilled and not cancelled. Shipped/prepaid/unknown payment → ticket, always.
- `agent_actions` is append-only (trigger + grants): it is the audit of what the agent did and cannot be edited, including by this runbook.
