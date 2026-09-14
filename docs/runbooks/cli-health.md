# CLI health — answer rates, rotation, retirement (E-28)

**Symptom:** the console's Numbers page shows a red banner ("active number(s) below the 25% answer rate"), a log alert `CLI answer rate below threshold` fired, or merchants report "not called" with reason `cli:none_available`.

## What the system does on its own

- Every night after 02:00 IST the reconcile worker computes, per number, the share of the last 7 days' **dials that reached the network** (`ENDED`, `NO_ANSWER`, `BUSY`, `AMD_*`) that a human answered, and stores it in `numbers.answer_rate_7d`. Engine errors and cancellations are not dials. Fewer than 20 dials → `null` ("no data").
- The gate (step 11) skips active numbers with a rate below `CLI_MIN_ANSWER_RATE_7D` (0.25) and picks the next eligible number. `null` counts as eligible, so a rested number comes back gently.
- The night a number first drops below the line, one `audit_log` row `cli.low_answer_rate` is written and the alert above fires. Nothing is retired automatically — E-28 is marked `[DECISION]` in the spec; a human decides.

## Confirm

Console → **Numbers**: rate, dials in 7 days, status, last used. Or:

```sql
select id, e164, status, answer_rate_7d, last_used_at, purpose_allowed
from numbers order by tenant_id nulls first, answer_rate_7d nulls last;
```

## Decide

| Situation | Action (console → the number's page) |
|---|---|
| Rate below 25% with ≥ 50 dials, other numbers fine | **Retire** with the reason. Buy a replacement if the pool is thin ([go-live 02 §4](../go-live/02-phone-numbers-and-dlt.md#4-buying-numbers)). |
| Every number's rate dropped at once | Not the numbers: check the script (opening line, timing), the engine's voice quality, or a carrier-wide issue. Do not retire. |
| Carrier / TrueCaller flagged the number as spam (merchant or customer report) | Retire immediately, whatever the rate. Note the report in the reason. |
| A retired number has rested ≥ 30 days | Set it back to **warming** (rate resets to no data), then **active** once a few calls look normal. |
| `cli:none_available` on the merchant's orders | No eligible number for that region/purpose/engine: activate a warmed number, set `purpose_allowed` from the TSP's letter, or move a pool number. |

Every change is audited as `staff:<you>` with the reason; the merchant sees it in their access log.

## Rules

- `purpose_allowed` is set from the TSP's written answer only (Q-01). Never add a purpose "to make a call go out".
- Keep at least two active pool numbers per region and engine; retiring the last one stops calling.
- Warm new numbers: low volume for the first week (the pilot percentage on the use case, or a small tenant).
- Owned support lines (`inbound_enabled`) are not rotated: they are the merchant's published number.
