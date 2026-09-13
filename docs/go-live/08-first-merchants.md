# 8. First merchants — Client A, Client B, the pilot

Prerequisites: an engine adapter merged ([03](03-voice-engine.md)), numbers registered
([02](02-phone-numbers-and-dlt.md)), stage (then production) applied and deployed
([05](05-cloud-infrastructure.md)), Postmark sending ([06](06-email-and-payments.md)).

## 1. Client A — Shopify store, COD confirmation (+ support line)

**Before Level 2 approval**, a public app installed on a real store receives `null` for customer
phone and name, so every COD order would be refused with `no_phone`. So:

1. **Pilot on the existing custom-app mirror** (P1-SHOP-1): Client A's own custom app sends its
   webhooks to hooks, verified with its secret in `SHOPIFY_WEBHOOK_SECRETS`. Confirm the custom
   app has protected customer data (phone, name) enabled in the store's app settings `[VERIFY]`.
2. Staff create the tenant for Client A's shop (see §3 while the gap exists) or, once the public
   app is approved, install it — provisioning creates the tenant, integration and owner user.
3. In the dashboard (or the Shopify app): Settings (business details, spend caps; auto-cancel stays
   **off** for the pilot), approve the COD script, set up the support line (profile, fallback
   number, transfer number verified by attestation), knowledge articles (returns, delivery times,
   COD charges).
4. Register Client A's **support number** as a tenant-owned number pointing at its active profile;
   agree the call-forwarding plan with the merchant.
5. Plan: Shopify Billing once on the public app; during the pilot, a written arrangement
   (`billing_provider = 'manual'`, set by staff).
6. Turn on the `cod_confirm` use case (go live). Start with `pilotPercent` below 100 in the use
   case config if you want a gradual start (deterministic by order).
7. After Level 2 approval: move to the public app ([04 §9](04-shopify-app.md#9-moving-client-a-from-the-custom-app-to-the-public-app)).

## 2. Client B — website, lead callback via the API

1. Staff create the tenant, the owner user and the `lead_callback` use case (§3).
2. The owner signs in at `app.naaradh.com/login` (email link), approves the lead-callback script,
   and creates an API key under **Developers** (owner role): a **secret** key for their server, or
   a **public site key** (`nrd_pk_…`, domain-restricted) for the website snippet.
3. Integration options:
   - **Server:** `POST https://api.naaradh.com/v1/intents` with `use_case: "lead_callback"`,
     phone, name, `external_ref`, `event_ts`, optional consent — see `apps/api/src/routes/intents.ts`
     for the exact body until the OpenAPI document is published (gap).
   - **Website snippet:** add
     `<script src="https://app.naaradh.com/naaradh.js" data-key="nrd_pk_…" async></script>`
     and mark the form with `data-naaradh` (usage in the header of `apps/web/public/naaradh.js`).
     It will move to `cdn.naaradh.com` later.
   - **Webhooks back:** `POST /v1/webhooks` with their HTTPS endpoint and events
     (`call.completed`, `outcome.final`, …); the signing secret is shown once.
4. Billing: Razorpay subscription from the dashboard Billing page (owner), or manual during the
   pilot.

## 3. Creating a direct merchant (today: SQL, by staff)

There is no "create merchant" screen yet (gap). Run as the **service** role against the target
environment, with generated ids (`ten_`/`usr_`/`usc_` + a ULID — generate with
`node --input-type=module -e "import {ulid} from 'ulid'; console.log(ulid())"` from
`packages/shared`). Placeholders only — never commit real values.

```sql
begin;
insert into tenants (id, name, legal_name, country, data_region, timezone, currency,
                     status, review_until, gstin, pan)
values ('ten_<ULID>', 'Client B', '<legal name>', 'IN', 'in', 'Asia/Kolkata', 'INR',
        'pending_review', now() + interval '7 days', '<GSTIN or null>', '<PAN or null>');
insert into users (id, tenant_id, email, name, role)
values ('usr_<ULID>', 'ten_<ULID>', '<owner email>', '<owner name>', 'owner');
insert into use_cases (id, tenant_id, kind, purpose, enabled, config)
values ('usc_<ULID>', 'ten_<ULID>', 'lead_callback', 'service', false,
        '{"defaultLocale":"en-IN","pilotPercent":100}');
commit;
```

Then add a draft script for the use case (shape: the `LEAD_CALLBACK_EN_IN` template in
`packages/scripts/src/templates.ts`; the local seed in `packages/db/src/seed.ts` shows a complete
insert). The owner approves it in the dashboard, which re-validates the disclosure.

**DLT link (promotional only):** after checking on the DLT portal that the merchant's PE is linked
to Naaradh: `update tenants set dlt_linked_at = now() where id = 'ten_…';` (service role; gap —
no console button yet).

## 4. Running the pilot

Watch daily:

- **Dashboard** (as the merchant sees it): Order calls → "Not called" reasons; Support calls →
  verification level and tools used; Tickets.
- **Staff console:** complaints, kill switches, disputes.
- **Alerts** (email from Cloud Monitoring): auto-pause on complaints, write-back give-up, billing
  reconciliation delta, dead letters.
- The first days: listen to a sample of recordings and read transcripts (both are audited);
  score extraction accuracy by hand.

Evidence for the Phase 1 exit (phase-1 review), from the production database:

```sql
-- zero calls outside 09:00–21:00 IST (must return 0)
select count(*) from call_attempts
where direction = 'outbound' and dispatched_at is not null
  and ((dispatched_at at time zone 'Asia/Kolkata')::time < '09:00'
    or (dispatched_at at time zone 'Asia/Kolkata')::time >= '21:00');

-- COD calls placed inside the 30-minute window
select count(*) filter (where a.dispatched_at <= i.event_ts + interval '30 minutes') as in_window,
       count(*) as total
from call_attempts a join call_intents i on i.id = a.intent_id
where i.use_case = 'cod_confirm';

-- every answered call has both disclosures logged (must return 0)
select count(*) from call_attempts
where answered_by = 'human' and (ai_disclosed_at is null or recording_disclosed_at is null);
```

Targets: Client A ≥ 200 real COD confirmation calls in the window; extraction ≥ 90% correct on
human review; inbound pilot 2 weeks, ≥ 300 calls, ≥ 50% resolved without a human, zero order
details given to unverified callers, tool p95 < 700 ms.

## Gaps you will hit

Found while checking the implementation for this guide — none blocks building, all are small
compared with the external items:

| Gap | Today | Suggested fix |
|---|---|---|
| Voice engine adapter | Simulator only | Build after ADR-0001 ([03](03-voice-engine.md#5-after-the-decision--code-work)) |
| Registering numbers | SQL by staff | Console "Numbers" page: add, assign to tenant/profile, set `purpose_allowed` with the evidence note, retire |
| Creating a direct (non-Shopify) merchant | SQL by staff | Console "New merchant": tenant + owner + use case + draft script, sends the sign-in invite |
| Marking a merchant's DLT PE link | SQL by staff | Console button on the tenant page |
| Transfer-number verification | Attestation only | Test call from onboarding (needs the engine) |
| Number answer-rate job (`cli-health`) | Not built | Nightly job computing `answer_rate_7d` from attempts |
| API reference for Client B | Code only (`pnpm openapi` is a stub) | Generate OpenAPI from the Zod route schemas; publish at docs.naaradh.com |
| RTO analytics export (BigQuery) | Dataset in Terraform; no export job | Nightly export job (P2-WEB-2 / P2-INF-2) |
| Shopify Flow trigger | Not built | Flow extension (P2-SHOP-7) |
| Voice choice in onboarding | Not built | Needs the engine's voice list |
| Snippet hosting | Served by the web app | `cdn.naaradh.com` (Cloud CDN) |
