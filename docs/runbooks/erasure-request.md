# Erasure request — DPDP / Shopify `customers/redact`

**Target:** completed within **30 days** of the request (`ERASURE_COMPLETION_TARGET_DAYS`, `TODO_LEGAL` Q-06). Overdue requests are logged as errors every pass of the retention worker — treat that alert as a compliance incident.

## Where requests come from

| Source | Path | Scope |
|---|---|---|
| Shopify `customers/redact` | hooks → intents-consumer → `erasure_requests` (+ order cache erased immediately) | that shop's tenant |
| Merchant forwards a customer's request | `POST /v1/erasure-requests` (scope `privacy:write`) — the merchant verified the person | that tenant |
| Email to `privacy@` / grievance officer | Staff verify identity, then file in the console | one tenant, or **all** (tenant blank) |

The public `/do-not-call` page **cannot** erase — only suppress. Erasure is destructive; it needs the person's identity verified first.

## What the retention worker erases (per tenant holding the phone hash)

1. Recordings and transcripts: deleted from the bucket **first** (outside any transaction), then `recording_uri`/`transcript_uri` nulled and `media_purged_at` set.
2. Contact: `erased_at`, `phone_enc`/`name`/locale/timezone nulled, masked number → `erased`. An erased contact is **never refilled** by a later order (`upsertContact`), and a later intent for it is gated `contact:erased`.
3. Outcome extraction: only `outcome, confidence, category, cancel_reason, pincode_confirmed, reschedule_date, quantity_change` kept; `notes`, `address_change`, `summary` dropped.
4. Intent variables: `customer_name`, `name`, `pincode` removed.
5. Order cache rows tombstoned (hashes, items, tracking removed).
6. Support ticket text replaced with `[erased]`.

**Kept, as the legal record (hash only, no number):** consents, suppressions, complaints, billing ledger, audit log, agent actions. Webhook payloads that may contain the number are nulled by reconcile after 30 days.

The request's `report` column shows counts per tenant. Merchant event `erasure.completed` per tenant.

## If a request is `failed` or overdue

```sql
select id, tenant_id, status, error, requested_at, due_at, started_at from erasure_requests
where status <> 'completed' order by due_at;
```

- `failed` rows are retried automatically an hour later. Repeated failures: read `error` — a bucket permission (`storage.objects.delete` for the workers service account) is the usual cause.
- `in_progress` for over an hour → the worker died mid-request; it will be reclaimed.
- To re-run a completed request (e.g. data arrived after completion): insert a new request; erasure is idempotent.

## Verifying

Pick one tenant from `report.tenants` and confirm: `select name, phone_enc, erased_at from contacts where phone_hash = '<hash>'` → nulls; the recording URI from before returns 404 from the bucket.

## Agent tool calls

`agent_actions` is append-only history, but its `args` hold the caller's own words (an address they read out, a ticket summary). Erasure blanks `args` and `result` to `{"erased": true}` on every action of the subject's attempts through `erase_agent_actions()` (migration 0011); the rows, tool names, statuses and timestamps stay.

## Analytics export

The nightly BigQuery export (`daily_call_facts`, `apps/workers/src/analytics`) holds per-tenant, per-day counts only — no phone numbers, hashes, ids or names (the row schema is strict and tested for it). Erasure therefore does not touch BigQuery; there is nothing per subject to remove.
