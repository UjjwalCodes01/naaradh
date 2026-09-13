# Engine outage

**Symptom:** dispatcher logs `engine circuit OPEN (E-20)` or a burst of `attempt.engine_error`; `/readyz` of the engine's status page is red; merchant calls stop.

## What the system does on its own

- Each `placeCall` that the adapter classifies as `ENGINE_UNAVAILABLE` (5xx, network) marks the attempt `FAILED`, releases the concurrency slot, and reschedules the intent in 1 minute **without** counting the attempt against the customer.
- Five such failures within 60 s open the breaker: Redis `circuit:<engine>` = `open` for 60 s. While open, the gate refuses at step 0 (`engine:circuit_open`) and defers every intent a minute. No calls are placed, nothing is lost.
- Tenants with `multi_engine_ok = true` fail over to `ENGINE_SECONDARY_*` while the breaker is open (gate step 0 records `failover_from`).
- `429` is different: honoured per `Retry-After`; it does not open the breaker.

## Confirm

```bash
redis-cli -u "$REDIS_URL" GET circuit:bolna            # "open" while tripped
redis-cli -u "$REDIS_URL" GET circuit_fail:bolna       # failures in the last minute
psql "$DATABASE_SERVICE_URL" -c "select end_reason, count(*) from call_attempts where created_at > now() - interval '10 minutes' group by 1"
```

## If it lasts more than a few minutes

1. Hold the breaker open by hand so it does not flap: `redis-cli SET circuit:bolna open EX 900`.
2. Decide on failover: `update tenants set multi_engine_ok = true where id in (…)` for the tenants you are willing to move, **only** if `ENGINE_SECONDARY_IN` is configured and its CLI pool has `purpose_allowed` set (Q-01 applies to every number).
3. COD intents expire after 30 minutes regardless — merchants see `intent:expired`/`engine:circuit_open` with the hint "calls resume automatically". Post to status.naaradh.com.
4. Live calls: if the engine died mid-call, reconcile will `fetchCall` after `max_duration + 60 s`; a `not_found` finalizes the attempt as `FAILED/engine_error` and the intent retries if the envelope allows.

## Recovery

`redis-cli DEL circuit:bolna circuit_fail:bolna`. Deferred intents resume within a minute. Check margin the next day: an outage that produced many short failed legs still cost vendor money (`vendor_cost_minor` on attempts).

## Cancel live calls (only if the engine is misbehaving *during* calls)

`cancelCall()` exists only for engines whose `capabilities().cancel` is true. Flip the tenant kill switch first (stops new dials), then for each live attempt call the vendor's cancel from a maintenance script; do not edit `call_attempts` by hand — let the vendor's `cancelled` event or reconcile close them.
