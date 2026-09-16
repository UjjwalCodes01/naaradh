# Appointments — calendars, reminders, bookings

**What exists:** an `appointments` row is the fact (from the merchant's system over the API, from a provider, or booked by the agent on a call); a `calendars` row is where free times come from. Naaradh places **one** confirmation call per appointment, between 24 and 2 hours before it starts, in the appointment's time zone and inside 09:00–21:00 there. Design: ADR-0011.

## Connecting a calendar (staff)

A credential is involved, so this is console work, not a merchant self-serve flow.

1. A human creates the provider credential and puts it in Secret Manager (`docs/go-live/09-woocommerce-and-appointments.md` has the gcloud commands). Naaradh stores only the reference.
2. Console → the tenant → **Calendars** → Connect: provider, the provider's event type id, the name the agent says ("Blood test"), time zone, slot length, the `sm://…` reference, and the provider config.
   - Cal.com needs `{"eventTypeId": 123456, "attendeeEmail": "appointments@merchant.example"}`. Providers require an attendee email and Naaradh asks customers for none, so bookings are made under that mailbox (Q-26).
3. `manual` is a calendar with no provider: Naaradh offers a fixed grid of slots from its own diary. Useful for a pilot, and what `pnpm dev` uses.

Disabling a calendar is immediate and needs a written reason. With no active calendar the agent has nothing to offer and says so — it never invents a time.

## "The customer was not reminded"

```sql
select id, external_id, service, starts_at, timezone, status, intent_id, reminder_swept_at,
       provider_ref, provider_error, phone_hash is null as no_phone
from appointments where tenant_id = '<ten_…>' order by starts_at desc limit 20;
```

| What you see | Meaning |
|---|---|
| `intent_id` set | the call is queued — follow it in the dashboard (Order calls) for the gate trace |
| `intent_id` null, `reminder_swept_at` null | not due yet: more than 24 hours away |
| `reminder_swept_at` set, no `intent_id` | Naaradh decided against a call: no phone, less than 2 hours away when it arrived (E-134), or the use case is off |
| `intent_id` set but the intent is `GATED` `consent:missing` | The appointment came with no record of how the customer asked (E-140). A reminder is a service call and India wants one. The merchant must send `consent` with the appointment (`PUT /v1/appointments/{ref}`); an appointment the agent booked on a call carries `verbal` consent automatically |
| `status` `cancelled`/`completed`/`no_show` | nothing to remind about |

The sweep runs on the reconcile tick. `appointment_confirm` must be **on** for the tenant (Settings → what Naaradh calls for) and have an approved script in the customer's language — it is a *service* purpose, so it needs no consent and no DLT template.

## "Everything is refused consent:missing"

A reminder is a **service** call, and the Indian and EU rules want a consent record for one. Send
it with the appointment:

```json
PUT /v1/appointments/lab-77
{ "phone": "…", "starts_at": "…", "timezone": "Asia/Kolkata",
  "consent": { "source": "form", "evidence_uri": "https://lab.example/bookings/77" } }
```

`source` says how the customer asked — `form` (a booking form), `api` (the merchant's own app),
`verbal` (taken on the phone; keep your own recording or note). One grant per appointment, in the
same ledger as every other consent, and visible in the consent query in
`promotional-calling.md`. Appointments the agent booked on a call record `verbal` consent with
the call as evidence, so their reminders work without the merchant doing anything.

## "The customer rescheduled but the old slot is still booked"

It should not be: when the agent books a new slot on a reminder call, the old appointment is
marked `cancelled` and the reconcile tick releases it with the provider (E-141). If the customer
asked to reschedule but nothing was booked (the provider was down, no time suited), the old row
stays `rescheduled` **and keeps its slot** — deliberately, so nobody ends up with no appointment.
Those rows are the ones to chase by hand:

```sql
select id, external_id, starts_at, provider_ref from appointments
where tenant_id = '<ten_…>' and status = 'rescheduled' and starts_at > now();
```

## "The agent offered a time that does not exist"

It cannot: `get_slots` returns only what the provider returned, `book_slot` accepts only a slot id from that same call's offer list (kept in `agent_actions`, not in the model's context), and a booking exists only when the provider confirmed it.

```sql
-- what was offered and what was booked on a call
select tool, status, result, at from agent_actions
where attempt_id = '<att_…>' and tool in ('get_slots','book_slot') order by at;
```

If a customer insists they were given a different time, that transcript plus these rows is the answer. A `slot_not_offered` refusal in the rows is the model trying to use a time it made up, and the tool stopping it.

## "A cancellation did not reach the calendar"

A cancellation decided on a call is recorded at once (the customer hears the truth immediately); telling the provider happens on the next reconcile tick.

```sql
select id, provider_ref, provider_cancelled_at, provider_error from appointments
where tenant_id = '<ten_…>' and status = 'cancelled' and provider_cancelled_at is null;
```

Rows here are still waiting. A transient provider error is retried each tick; a permanent one stamps `provider_cancelled_at` with the error kept in `provider_error`, so it stops being retried and a person can fix it in the provider's own UI. `calendar_removed` means the calendar row is gone — nothing to tell.

## Clinical questions

The shipped appointment scripts forbid diagnosis, prescriptions, test results and any medical advice; such a question becomes `needs_merchant_action` (a ticket) or a transfer. A merchant asking for a script that answers clinical questions is refused — that is an AUP matter, not a script tweak.
