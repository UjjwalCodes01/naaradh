# Case-study data pack (P4-GTM-1)

The numbers for a merchant case study, straight from production, with nothing that identifies a
customer. Run each query as the **service role** with the merchant's tenant id and the two date
ranges you are comparing (before Naaradh / after). Paste the results into the case study; keep
the raw output with it so a claim can be checked later.

**Before you publish anything:** written permission from the merchant for their name and
numbers (P4-GTM-1), and no phone numbers, customer names or recordings in the document.

```sql
\set tenant 'ten_…'
\set from '2026-09-01'
\set to   '2026-10-01'
```

## 1. Order confirmation — the RTO argument

```sql
select count(*)                                                        as calls,
       count(*) filter (where a.answered_by = 'human')                 as reached_a_person,
       count(*) filter (where o.outcome in ('confirmed','confirmed_with_changes')) as confirmed,
       count(*) filter (where o.outcome = 'cancelled')                  as cancelled_before_shipping,
       count(*) filter (where o.outcome = 'convert_to_prepaid_requested') as wanted_prepaid,
       round(100.0 * count(*) filter (where a.answered_by = 'human') / greatest(count(*),1), 1) as answer_rate_pct
from call_attempts a
join call_intents i on i.id = a.intent_id
left join call_outcomes o on o.attempt_id = a.id
where a.tenant_id = :'tenant' and i.use_case = 'cod_confirm'
  and a.dispatched_at >= :'from' and a.dispatched_at < :'to';
```

`cancelled_before_shipping` × the merchant's own return-to-origin cost is the saving claim. Use
**their** figure (the one they entered in Settings → Results), state it in the case study, and
never present the estimate as measured revenue.

## 2. Abandoned checkout — the recovery argument

```sql
select count(*)                                                     as checkouts,
       count(*) filter (where consent_wording is not null)          as consented,
       count(*) filter (where status = 'scheduled')                 as called,
       count(*) filter (where status = 'converted')                 as ordered_afterwards
from checkouts
where tenant_id = :'tenant' and source_created_at >= :'from' and source_created_at < :'to';

select count(*) filter (where reversed_at is null)            as recovered_orders,
       sum(value_minor) filter (where reversed_at is null)/100 as recovered_value,
       currency
from attributions
where tenant_id = :'tenant' and order_placed_at >= :'from' and order_placed_at < :'to'
group by currency;
```

State the attribution rule in the case study in one sentence: *an order from the same customer
within 24 hours of a recovery call they answered.* It is a measurement, not proof of cause
(ADR-0010 §9).

## 3. Support line — the deflection argument

```sql
select count(*)                                                       as inbound_calls,
       count(*) filter (where o.outcome = 'resolved')                 as resolved_by_the_agent,
       count(*) filter (where o.outcome = 'ticket_created')            as needed_the_team,
       count(*) filter (where o.outcome = 'transferred')               as transferred,
       round(sum(a.billable_sec)/60.0, 0)                              as billed_minutes
from call_attempts a
left join call_outcomes o on o.attempt_id = a.id
where a.tenant_id = :'tenant' and a.direction = 'inbound'
  and a.started_at >= :'from' and a.started_at < :'to';
```

## 4. What it cost them

```sql
select kind, sum(qty) as units, sum(total_minor)/100 as charged, currency
from billing_ledger
where tenant_id = :'tenant' and created_at >= :'from' and created_at < :'to'
group by kind, currency order by kind;
```

## 5. Quality claims (only with evidence)

```sql
-- complaints in the period (a case study that hides these is worthless internally)
select count(*) from complaints where tenant_id = :'tenant'
  and received_at >= :'from' and received_at < :'to';

-- QA reviews behind any "accuracy" claim
select count(*) as reviewed,
       count(*) filter (where extraction_correct) as extraction_correct
from qa_reviews where tenant_id = :'tenant' and status = 'done'
  and reviewed_at >= :'from' and reviewed_at < :'to';
```

Claim accuracy only from reviewed calls, and say how many were reviewed.
