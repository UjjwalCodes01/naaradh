# Complaint received — intake, attribution, tenant pause

**Why it matters (E-05):** 5 valid complaints in a rolling 10 days can get every telecom resource blacklisted across TSPs for up to a year. Naaradh pauses a **tenant at 3** and trips the **global kill at 5** — well before the regulator's trigger.

## Where complaints come from

| Source | How it enters | `complaint_source` |
|---|---|---|
| TRAI / TSP / engine vendor forwards one | Staff files it in the console (reporter `staff:<email>`) | `trai` / `vendor` |
| A merchant's customer complains to the merchant | `POST /v1/complaints` (scope `complaints:write`) | `merchant` |
| The person themselves | `/do-not-call` page → "report an unwanted call" | `self_service` |

Every path writes a row to `complaint_reports` (the queue). The **complaints worker** (`WORKER=complaints` or `all`, service role) then:

1. **Attributes** it to the tenant whose *outbound* call reached that phone hash most recently in the last **30 days** (`COMPLAINT_ATTRIBUTION_DAYS`). A merchant report is attributed to that merchant.
2. No such call → `unattributed`: nobody is counted (a spoofed CLI must not pause an innocent tenant), but the number is **still suppressed globally**.
3. Otherwise `recordComplaint()` inserts the complaint, suppresses the number globally (indefinitely), and recounts: **3 in 10 days → tenant `paused`**, **5 across all tenants → global kill** (Postgres row + Redis `ks:global:*`).
4. Merchant events `complaint.received` / `tenant.paused` / `promotional.paused`; audit `complaint.recorded` / `tenant.auto_paused` / `tenant.promotional_paused`; Error Reporting on a pause, `fatal` on the global kill. The complaint records the purpose and use case of the attributed call.

## On a tenant auto-pause (alert: "tenant auto-paused on complaints")

```sql
select id, source, status, attempt_id, received_at, notes from complaints
where tenant_id = '<ten_…>' and received_at > now() - interval '10 days' order by received_at;
```

1. Listen to the attributed calls (`attempt_id` → console recording, audited). Was there consent / was it transactional / was the script followed?
2. For each complaint decide **valid** or **invalid** in the console (`resolveComplaint`). Only a human may mark one invalid; invalid complaints stop counting.
3. Resuming is a **separate, deliberate** action: console → tenant → Resume, with a written reason (≥ 10 characters, audited as `tenant.resumed`). Do not resume while a valid-complaint pattern is unexplained.
4. Tell the merchant what happened and what changes (script, consent source, hours) before they go live again.

## A complaint about a promotional call

If the attributed call was promotional (abandoned cart, feedback — the console shows a `promotional` badge), the tenant's **promotional** calling is paused at once, whatever the count (ADR-0010 §5, E-113). Order confirmations and the support line continue. Follow `promotional-calling.md` → Promotional pause. The complaint still counts towards the 3/5 thresholds above.

## On the global kill (alert: "GLOBAL KILL SWITCH tripped on complaints")

Every outbound dial stops (inbound answering does not — it has its own `inbound:*` switch). Follow `kill-switch.md`. Do **not** clear the switch until the five complaints are reviewed and the cause is contained. `[LEGAL]` Q-05: who is telemarketer-of-record for a TRAI response is still open — involve the lawyer before replying to a TSP.

## Checking a report

```sql
select id, status, tenant_id, complaint_id, reporter, reported_at, processed_at
from complaint_reports order by reported_at desc limit 20;
```

`pending` for more than a few minutes → the complaints worker is not running. `unattributed` is normal for numbers we never called.
