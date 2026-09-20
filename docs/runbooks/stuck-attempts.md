# Stuck attempts

**Symptom:** `call_attempts` rows sit in `DIALING` / `RINGING` / `IN_CONVERSATION` / `UNCERTAIN` for longer than a call can last; concurrency counters look full while nothing is ringing; merchants see intents "in progress" for an hour.

## What reconcile does every minute (`workers/src/reconcile`)

| Case | Rule | Result |
|---|---|---|
| Stale claim | intent `DISPATCHING`, `claimed_at` > 2 min, no live attempt | back to `SCHEDULED`, due now |
| Stuck live attempt | live status, no event for `max_duration_sec + 60 s` | `fetchCall()`; ended/failed/not_found → finalized from the vendor snapshot; still running → deadline extended |
| Uncertain dispatch | `UNCERTAIN` (timeout after send) | `findCallByIdempotencyKey()`; found → adopted (and finalized if over); not found after 2 min → `FAILED`, slot released, intent rescheduled with the attempt not counted |
| Expired | waiting intents past `not_after` | `EXPIRED`, reason `intent:expired` |
| Concurrency leak | always | Redis `conc:*` counters overwritten from the live-attempt query |

If reconcile is running, most stuck states clear themselves within two passes. Check it is running first:

```bash
psql "$DATABASE_SERVICE_URL" -c "select count(*) from call_attempts where status in ('DIALING','RINGING','IN_CONVERSATION','TRANSFERRING','UNCERTAIN') and coalesce(last_event_at, dispatched_at) < now() - interval '15 minutes'"
```

A non-zero count that is not shrinking means reconcile is down or the engine's `fetchCall` is failing. Look for `reconcile pass failed` in the logs.

## Manual repair (service role; audit everything)

Never set an attempt to `ENDED` with `answered_by = 'human'` by hand: the disclosure trigger will refuse it, and rightly — you do not know that a disclosure was played. Close it as the vendor reports it, or as `FAILED`:

```sql
-- 1. ask the vendor what happened (their dashboard / API) — then:
update call_attempts set status = 'FAILED', end_reason = 'manual_reconcile', ended_at = now(), last_event_at = now()
 where id = 'att_…' and ended_at is null;
update call_intents set status = 'SCHEDULED', next_attempt_at = now(), attempts_count = greatest(attempts_count - 1, 0)
 where id = (select intent_id from call_attempts where id = 'att_…') and status = 'IN_PROGRESS' and not_after > now();
insert into audit_log (id, tenant_id, actor_type, actor_id, action, target_type, target_id, after)
 values ('aud_<ulid>', '<ten_…>', 'user', '<you>', 'attempt.manual_reconcile', 'call_attempt', 'att_…', '{"reason":"<why>"}');
```

Concurrency: `redis-cli DECR conc:tenant:<ten_…>` and `DECR conc:engine:<vendor>` if reconcile is not running; otherwise wait a minute — it rewrites both from the truth.

## Do not

- Do not extend `not_after` "so the retry fits" — the trigger refuses and so does invariant 4.
- Do not delete attempts. They are the record of what was dialled.
