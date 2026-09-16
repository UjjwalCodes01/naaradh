# Zapier, Make, n8n and other automation tools

Naaradh ships no automation-platform app (ADR-0011 §9): the public API and the signed merchant
webhooks are already what those tools speak, and one more OAuth client per vendor is a
maintenance cost with no new capability. These are the recipes that work today.

Keys come from the dashboard → **Developers**. Give each automation its own key with the
narrowest scopes and its own daily cap, so one broken zap cannot spend a month's calls.

## Trigger: "a call finished" → anything

Register a webhook (dashboard → Developers, or `POST /v1/webhooks`) pointing at your tool's
catch hook, subscribed to the events you want:

| Event | Fires when | Typical use |
|---|---|---|
| `outcome.final` | every call ends | write the result to a sheet, notify a channel |
| `intent.gated` | Naaradh decided not to call | tell the team why (no consent, outside hours, suppressed) |
| `ticket.created` | the agent raised a ticket | create a task in your helpdesk |
| `order.cancellation_requested` | a caller asked to cancel | a human approves it in your system |
| `checkout.recovery_requested` | a customer wants their cart link | send the link with your own email/WhatsApp |
| `order.recovered` | an order followed a recovery call | attribution reporting (never billed) |
| `appointment.booked` | the agent booked a slot | confirm by SMS from your own sender |

Every delivery carries `X-Naaradh-Signature: t=<unix>,v1=<hex>` where
`v1 = HMAC-SHA256(secret, t + "." + raw_body)`. **Verify it before you trust the body**, reject
anything older than 300 seconds, and dedupe on the body's `id` — delivery is at-least-once.

Zapier: *Webhooks by Zapier → Catch Raw Hook* (raw, so you can verify the signature over the
exact bytes; a parsed hook re-serialises the JSON and the HMAC will not match). Make: a *Custom
webhook* with "Get request headers" on. n8n: a *Webhook* node with `Raw Body` enabled, then a
*Crypto* node.

## Action: "start a call"

```
POST https://api.naaradh.com/v1/intents
Authorization: Bearer nrd_live_…
Idempotency-Key: <your own stable id for this event>
{
  "use_case": "lead_callback",
  "phone": "{{phone}}",
  "name": "{{first_name}}",
  "external_ref": "{{record_id}}",
  "variables": { "topic": "{{topic}}" }
}
```

The response says what happened: `scheduled`, `gated` with a reason, `duplicate`, or `skipped`.
Treat `gated` as information, not an error — it is the compliance layer refusing, and the reason
is written for a person to read.

`lead_callback` is a **service** purpose: the customer asked to be called, so no consent row is
needed (E-138). Promotional use cases are refused without one, whatever the automation sends.

## CRM recipes (Zoho, HubSpot, Pipedrive…)

Until the marketplace apps exist (P5-CRM-1/2, blocked on per-vendor OAuth clients), wire the CRM
through its own automation:

- **New lead who asked for a call** → the action above with `external_ref` = the CRM record id.
- **`outcome.final`** → update that record: `booked`/`qualified` → move the stage;
  `not_interested` → close it; `callback_requested` → task for tomorrow;
  `opt_out` → mark do-not-call in the CRM too (Naaradh has already stopped).
- Do **not** push a CRM list into Naaradh as promotional calls: without consent evidence it is
  gated, and a bought list is an AUP breach (E-71).

## Carts and appointments from a custom store

Same API, two routes: `PUT /v1/carts/{ref}` (with the consent wording version the shopper
ticked) and `PUT /v1/appointments/{ref}`. Both are idempotent on your reference; send updates as
often as you like. See the OpenAPI reference for every field.

## Rate limits and caps

Per-key daily caps and per-minute rate limits apply to automations exactly as to your own code.
A `429` carries `Retry-After`; respect it rather than looping — a retry storm burns the cap that
also feeds your real calls (E-122).
