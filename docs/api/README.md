# Naaradh API reference

`openapi.json` in this folder is the OpenAPI 3.1 description of `api.naaradh.com`. It is
**generated** from the Zod schemas the routes validate with (`api/src/openapi.ts`), so the
request shapes here are the request shapes the server accepts. The live copy is served at
`GET https://api.naaradh.com/v1/openapi.json` (no API key).

- Regenerate after changing a route: `pnpm openapi` (writes this file). CI fails on drift.
- View it: paste into any OpenAPI viewer (Swagger UI, Redocly, Stoplight) or open
  `docs.naaradh.com` once that host exists (Phase 5).
- A route that exists but is not documented fails `api/test/unit/openapi.test.ts`.
- [`automation.md`](automation.md) — Zapier / Make / n8n and CRM recipes on this API (ADR-0011 §9).
- [`sdks.md`](sdks.md) — generating a client from the document, and webhook signature verification in Node, Python and PHP.

## Quickstart for a website integration (Client B)

Keys come from the dashboard, **Developers** page (owner role). Placeholders below; phone numbers
in the reserved test range only (`+91 60000 00xxx`) — the simulator refuses anything else, and so
must your tests.

### 1. Create a lead-callback intent from your server

```bash
curl -X POST https://api.naaradh.com/v1/intents \
  -H 'Authorization: Bearer nrd_live_REPLACE_ME' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: lead-8f3a2c' \
  -d '{
    "use_case": "lead_callback",
    "phone": "+91 60000 00001",
    "name": "Asha Test",
    "external_ref": "lead-8f3a2c",
    "event_ts": "2026-09-14T09:12:00+05:30",
    "consent": { "purpose": "service", "source": "form", "wording_version": "site-v1" }
  }'
```

Responses: `202 scheduled` (with the calling window), `202 merged`, `202 gated` (with the reason
and a hint), or `200 duplicate` / `200 skipped`. The gate decides inside the request; nothing is
ever dialled outside 09:00–21:00 IST or against a suppression.

### 2. Or from the website with the snippet

```html
<script src="https://app.naaradh.com/naaradh.js" data-key="nrd_pk_REPLACE_ME" async></script>
<form data-naaradh>…</form>
```

Public site keys (`nrd_pk_…`) are domain-restricted and can only create `lead_callback` intents.

### 3. Receive the result

Register an endpoint once:

```bash
curl -X POST https://api.naaradh.com/v1/webhooks \
  -H 'Authorization: Bearer nrd_live_REPLACE_ME' -H 'Content-Type: application/json' \
  -d '{ "url": "https://example.com/naaradh/hooks", "events": ["call.completed", "outcome.final"] }'
```

The signing secret is returned **once**. Every delivery carries
`X-Naaradh-Signature: t=<unix seconds>,v1=<hex>` where `v1 = HMAC-SHA256(secret, t + "." + raw_body)`.
Verify over the raw bytes, reject when `|now − t|` exceeds the replay window, compare in constant
time, and dedupe on `X-Naaradh-Event-Id`. Failed deliveries are retried five times over 12 hours,
then marked `dead` (visible at `GET /v1/webhooks/deliveries`).

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
export function verify(secret, header, rawBody, now = Date.now() / 1000) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m || Math.abs(now - Number(m[1])) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]));
}
```

### Errors

Every error is `{"error": {"code", "message", "details?", "request_id"}}`. Quote `request_id`
when writing to support@naaradh.com.
