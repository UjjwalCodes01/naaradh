# Kill switch

**Symptom:** you need calling to stop — everywhere, for one engine, for one merchant, or for one campaign — within seconds.

**Mechanism (invariant 12):** the dispatcher checks four switches, in order, on every dispatch — global → engine → tenant → campaign — reading Redis with a 5-second in-process cache. A switch that is ON makes the gate refuse at step 2 with `kill:<scope>`; intents are deferred five minutes and re-evaluated, so nothing is lost. The durable record is the `kill_switches` table; Redis is the hot copy.

Redis keys (`compliance/src/adapters/redis.ts`): `ks:global:*`, `ks:engine:<vendor>`, `ks:tenant:<ten_…>`, `ks:campaign:<cmp_…>`.

## Flip ON (≤ 5 s to take effect)

```bash
# 1. Redis — this is what stops calls
redis-cli -u "$REDIS_URL" SET 'ks:global:*' 1                       # everything
redis-cli -u "$REDIS_URL" SET 'ks:engine:bolna' 1                   # one engine
redis-cli -u "$REDIS_URL" SET 'ks:tenant:ten_01…' 1                 # one merchant
redis-cli -u "$REDIS_URL" SET 'ks:campaign:cmp_01…' 1               # one campaign

# 2. Postgres — the record (service role)
psql "$DATABASE_SERVICE_URL" -c "insert into kill_switches (scope, key, active, reason, set_by)
  values ('global', '*', true, '<why>', '<your name>')
  on conflict (scope, key) do update set active = true, reason = excluded.reason, set_by = excluded.set_by, set_at = now();"
```

Calls already in progress are **not** cut off; the switch stops new dials. To also stop live calls, see `engine-outage.md` § cancel live calls.

## Verify

```bash
redis-cli -u "$REDIS_URL" GET 'ks:global:*'      # "1"
psql "$DATABASE_SERVICE_URL" -c "select count(*) from call_attempts where dispatched_at > now() - interval '2 minutes'"  # should stop growing
```

Dispatcher logs show `intent.deferred` with `reason: kill:global`.

## Flip OFF

```bash
redis-cli -u "$REDIS_URL" DEL 'ks:global:*'
psql "$DATABASE_SERVICE_URL" -c "update kill_switches set active = false, set_by = '<you>', set_at = now() where scope='global' and key='*';"
```

Deferred intents resume at their `next_attempt_at` (≤ 5 minutes). Any whose `not_after` passed while the switch was on are `EXPIRED` by reconcile — for COD that is most of them; the merchant sees them as gated with a hint.

## Automatic trips

- **E-05:** 5 counted complaints across all tenants in 10 days → `recordComplaint()` sets the global switch (Redis + row). Do not clear it without the founder and the complaint log in front of you.
- **Redis unreachable:** the global switch reads as ON (fail closed). Fix Redis; nothing to flip.

## Audit

Every flip must leave a `kill_switches` row (who, why, when). Add an `audit_log` row with `action = 'kill_switch.flipped'` if you flipped it by hand from psql.
