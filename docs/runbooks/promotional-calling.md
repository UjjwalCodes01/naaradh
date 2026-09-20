# Promotional calling — abandoned cart, feedback, the promotional pause

**Why it matters:** promotional calls carry the regulatory risk that ends a telecom business (SPEC §4.1.1). Naaradh refuses a promotional call for any missing piece and says which one. This runbook is for "why was nobody called?", "why was this person called?" and the promotional pause. Design: ADR-0010.

## What has to be true before a promotional call is placed

In order — the gate reason names the first one missing:

| Requirement | Where it is set | Refusal |
|---|---|---|
| Tenant not promotionally paused | complaint about a promotional call; staff lift in the console | `tenant:promotional_paused` |
| Tenant out of the 7-day new-account review | automatic | `tenant:pending_review_promotional` |
| A live consent from **our** checkbox, under 7 days old (India) | checkout extension / cart block → `consents` | `consent:missing`, `consent:expired` |
| DND scrub says `not_registered` | TSP scrub provider (Q-02) at dial time | `dnd:registered`, `dnd:unknown` |
| No promotional call to this phone from this tenant in 7 days; one attempt per checkout / delivery | automatic | `attempts:promotional_cooldown`, `attempts:lifetime` |
| DLT principal entity linked to Naaradh | console → tenant → DLT | `consent:dlt_not_linked` |
| Approved script with its DLT content template id | dashboard → Call scripts | `script:dlt_template_missing` |
| 09:00–21:00 in the recipient's zone | automatic | `window:closed` (waits for 09:00 if still inside the deadline) |

**No DND provider is wired yet (Q-02).** Until one is, every promotional call is refused `dnd:unknown`. That is deliberate (ADR-0010 §6). Plugging one in: implement `DndProvider` (`compliance/src/adapters/dnd.ts`) and pass it as `dnd` in the workers' context (`workers/src/index.ts`). The dispatcher scrubs just before the gate, because it is the only place the number can be decrypted.

## "This checkout was not called"

```sql
select status, skip_reason, intent_id, source_created_at, source_updated_at, swept_at
from checkouts where tenant_id = '<ten_…>' and external_id = '<checkout token>';
```

| `status` / `skip_reason` | Meaning |
|---|---|
| `open` | still inside the 45-minute quiet period, or the reconcile worker is not running (sweep runs every tick) |
| `skipped` / `consent:missing` | the box was not ticked (Shopify marketing consent does not count, E-107), or it was unticked (E-105), or the wording version was unknown (E-106 — look for `consent.unknown_wording` in `audit_log`) |
| `skipped` / `no_phone` | no phone on the checkout when it went quiet; a later update with a phone reopens it (E-100) |
| `skipped` / `recently_called` | another promotional call to this phone in 7 days (E-108) |
| `skipped` / `already_handled` | this cart already had its one intent |
| `skipped` / `use_case_disabled` | abandoned cart is off in Settings |
| `completed` / `converted` | the shopper finished, or ordered from the same phone or checkout (E-102) |
| `expired` | older than 24 h when first swept (E-110) |
| `scheduled` | an intent exists — follow `intent_id` to the gate trace in the dashboard |

A store on GoKwik / Shiprocket / Magic checkout sends **no** checkout webhooks (E-14): zero rows is expected there.

## "Why was this person called?" (a consent challenge)

```sql
-- the grant(s) and any revocation, with the wording version the shopper saw
select id, action, grant_id, purpose, source, wording_version, external_ref, captured_at, expires_at, context
from consents where tenant_id = '<ten_…>' and phone_hash = '<hash>' order by captured_at;

-- the call, the template it ran under, and the script version
select a.id, a.purpose, a.dlt_template_id, a.script_id, a.script_version, a.dispatched_at, i.use_case, i.gate_trace
from call_attempts a join call_intents i on i.id = a.intent_id
where a.tenant_id = '<ten_…>' and a.phone_hash = '<hash>' order by a.created_at;
```

The gate trace on the intent records every step that passed. The wording text for a version is in `pipeline/src/promotional/consent-wording.ts` (versions are never deleted). **Audit query for the exit criterion "zero non-consented promotional calls":**

```sql
select a.id from call_attempts a
where a.purpose = 'promotional' and a.dispatched_at is not null
  and not exists (
    select 1 from consents c
    where c.tenant_id = a.tenant_id and c.phone_hash = a.phone_hash and c.action = 'grant'
      and c.purpose in ('promotional','all') and c.captured_at <= a.dispatched_at
      and (c.expires_at is null or c.expires_at > a.dispatched_at)
      and not exists (select 1 from consents r where r.action = 'revoke' and r.grant_id = c.id and r.captured_at <= a.dispatched_at));
```

It must return nothing. Any row is a compliance incident: kill-switch the tenant (`kill-switch.md`) and investigate.

## Promotional pause (alert: "promotional calling paused on a promotional complaint")

A complaint attributed to a promotional call sets `tenants.promotional_paused_at` (ADR-0010 §5). Order confirmations and the support line continue; the merchant sees a banner and got a `promotional.paused` email/webhook. The E-05 counters (3 → full pause, 5 → global kill) still count this complaint — see `complaint-received.md`.

1. Console → the tenant's page → Complaints: the row shows the use case and a `promotional` badge. Listen to the call (audited).
2. Check the consent (query above): was there a live grant, which wording, from which checkout?
3. Check the script: opt-out line present, no link/discount promises, template id correct.
4. Decide the complaint valid/invalid (console). Only then, console → tenant → **Resume promotional calling**, with a written reason (≥ 10 characters, audited `tenant.promotional_resumed`).

Calls refused while paused stay `GATED` — they are not replayed after the lift; the next checkout is.

## The merchant says "the customer wanted the link but got nothing"

Naaradh sends no SMS or WhatsApp (Q-21). The merchant received `checkout.recovery_requested` (see Developers → webhook health, or `merchant_webhook_deliveries`). They must send the link with their own tools. If they have no webhook endpoint, point them to Shopify's abandoned-checkout email or Flow.

## Recovered orders look wrong

`attributions` holds one row per order (last touch, human-answered, within `attribution_hours`, default 24). Reversed rows (`reversed_at`) are excluded from revenue. Nothing here is billed (invariant 11, Q-24). A test order is never attributed.
