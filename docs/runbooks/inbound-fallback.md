# Inbound fallback — callers are not reaching the agent

**Symptom:** a merchant says "customers get forwarded to our own phone" or "customers hear a closed message"; the dashboard shows `inbound.call_refused` events; `audit_log` has `inbound.refused` rows.

Every refused inbound call is **forwarded to the merchant's fallback line** (if the profile has one) or hears the **closed message** with business hours — never silence (E-92). The reason is on the audit row, so start there.

## Find the reason

```bash
psql "$DATABASE_SERVICE_URL" -c "
  select at, after->>'reason' as reason, after->>'fallback' as fallback, count(*) over (partition by after->>'reason') as n
  from audit_log
  where tenant_id = '<ten_…>' and action = 'inbound.refused' and at > now() - interval '1 hour'
  order by at desc limit 20"
```

| `reason` | What it means | What to do |
|---|---|---|
| `inbound:number_unrouted` | The number has no tenant, no profile, `inbound_enabled = false`, or is not `active` (E-81). | Check `numbers` for the called E.164: `tenant_id`, `inbound_profile_id`, `inbound_enabled`, `status`. Number changes are an ops action (service role). |
| `inbound:profile_inactive` | The profile is `draft` or `disabled`. | The merchant activates it: `POST /v1/inbound-profiles/:id/activate` (re-validates the disclosure). |
| `inbound:tenant_inactive` | Tenant paused/suspended/uninstalled. | Same as outbound: see why the tenant is paused before un-pausing. |
| `inbound:billing` | Billing not active and past the grace period (E-50). | Billing issue, not an engineering one. |
| `inbound:kill` | `ks:inbound:*` or `ks:inbound:<tenant>` is set. | Intended? See `kill-switch.md`. An **outbound** global kill does not stop answering. |
| `inbound:minute_cap` | This month's metered minutes ≥ the profile cap (or 10,000 default). | `select sum(qty) from billing_ledger where tenant_id = … and kind = 'minute' and period = to_char(now(), 'YYYY-MM')`. Raise `monthly_minute_cap` only with the merchant's agreement (it is their spend). |
| `inbound:concurrency` | All of the tenant's agent lines (`max_concurrent`) or the engine's are busy. | Normal at peaks. If it persists with no live calls, the counter leaked: see below. |
| `inbound:abuse` | One caller rang more than `max_calls_per_caller_hour` times (E-88). They hear a short message; staff are **not** rung. | Nothing, unless the merchant wants the limit raised. |
| `inbound:engine_down` | The engine's breaker is open. | See `engine-outage.md`. |

A context request that fails outright (database down, bug) is logged `inbound: decision failed, falling back` and forwarded — check Error Reporting for the stack.

## Leaked inbound slots

Inbound slots are counted under `conc:tenant:inbound:<tenant>` (separate from outbound). The finalize path releases a slot on `call.ended`; reconcile rebuilds every counter from live attempts each minute. If a counter looks stuck:

```bash
redis-cli -u "$REDIS_URL" GET conc:tenant:inbound:<ten_…>
psql "$DATABASE_SERVICE_URL" -c "select count(*) from call_attempts where tenant_id = '<ten_…>' and direction = 'inbound' and status in ('RINGING','IN_CONVERSATION','TRANSFERRING')"
```

If Redis is higher than Postgres, wait one reconcile interval; if reconcile is not running, that is the incident. Never `DEL` the key while calls are live — it lets a burst over-admit.

## The fallback itself is wrong

- **Forward goes nowhere:** the fallback number is encrypted with the **staff** key. If `STAFF_ENC_PRIVATE_KEY` on voice does not match the key the number was stored with, decryption fails and the caller gets the closed message instead. Re-enter the number via `PUT /v1/inbound-profiles/:id`.
- **Closed message says "business hours":** the profile's `business_hours` did not validate. Fix it through the API; the closed message and the transfer rule both depend on it.

## Engine-side timeout

If voice is down entirely, the engine's own timeout fallback plays (configure it on every inbound number at provisioning). `/readyz` on voice reports `db` and `redis`; Cloud Run min-instances ≥ 1 in production so a cold start never eats the 2 s engine budget.
