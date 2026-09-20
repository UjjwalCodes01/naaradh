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
2. Staff create the tenant for Client A's shop in the console (§3) or, once the public
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

1. Staff create the tenant with the owner and the `lead_callback` use case in the console (§3).
2. The owner signs in at `app.naaradh.com/login` (email link), approves the lead-callback script,
   and creates an API key under **Developers** (owner role): a **secret** key for their server, or
   a **public site key** (`nrd_pk_…`, domain-restricted) for the website snippet.
3. Integration options:
   - **Server:** `POST https://api.naaradh.com/v1/intents` with `use_case: "lead_callback"`,
     phone, name, `external_ref`, `event_ts`, optional consent — reference: `docs/api/openapi.json`
     (also served at `GET /v1/openapi.json`) and the quickstart in `docs/api/README.md`.
   - **Website snippet:** add
     `<script src="https://app.naaradh.com/naaradh.js" data-key="nrd_pk_…" async></script>`
     and mark the form with `data-naaradh` (usage in the header of `web/public/naaradh.js`).
     It will move to `cdn.naaradh.com` later.
   - **Webhooks back:** `POST /v1/webhooks` with their HTTPS endpoint and events
     (`call.completed`, `outcome.final`, …); the signing secret is shown once.
4. Billing: Razorpay subscription from the dashboard Billing page (owner), or manual during the
   pilot.

## 3. Creating a direct merchant (staff console → Tenants → New merchant)

Console → **Tenants** → *+ New merchant*: brand and legal name, country/time zone/currency,
GSTIN/PAN (validated), the owner's email, the use cases to set up (`cod_confirm`,
`abandoned_cart`, `lead_callback`, `feedback` — all OFF, with draft scripts from the default templates for
the owner to approve), the default script language, and a note saying why the merchant is
created by hand. The tenant starts in **pending review** for 7 days (E-73). No email is sent:
the owner requests a sign-in link at `app.naaradh.com/login` (the console shows the exact URL).
Shopify stores are never created here — they provision themselves on install.

**DLT link (promotional only):** after checking on the DLT portal that the merchant's PE
authorised Naaradh as its telemarketer, open the tenant in the console → *DLT principal entity*
card → PE id + what you checked → **Mark PE linked**. Promotional use cases stay blocked until
then; the link can be removed the same way.

**Before switching on abandoned cart or feedback (promotional, ADR-0010)** — the gate refuses
every call until all of these hold, and the dashboard says which one is missing:

1. DLT PE linked (above) and the tenant out of the 7-day review.
2. A **DND scrub provider** wired into the workers (`dnd` in the worker context, Q-02). Without
   one every promotional call is refused `dnd:unknown` — by design.
3. Counsel-approved consent wording (Q-08) and the extension/cart block deployed and added to
   the store (`04-shopify-app.md`).
4. Each promotional script approved **with the DLT content template id** it was registered
   under (Q-23). The dashboard asks for it on approval.
5. The merchant knows Naaradh sends no SMS/WhatsApp: a customer who wants the cart link produces
   `checkout.recovery_requested`, and the merchant sends it (Q-21).

Runbook: `docs/runbooks/promotional-calling.md` (includes the audit query for "zero
non-consented promotional calls").

## 4. Running the pilot

Watch daily:

- **Dashboard** (as the merchant sees it): Order calls → "Not called" reasons; Support calls →
  verification level and tools used; Tickets.
- **Staff console:** complaints, kill switches, disputes.
- **Alerts** (email from Cloud Monitoring): auto-pause on complaints, write-back give-up, billing
  reconciliation delta, dead letters.
- The first days: listen to a sample of recordings and read transcripts (both are audited);
  score extraction accuracy by hand. From the first Monday on, the console's **QA review** queue
  does this systematically (2% a week, `docs/runbooks/qa-review.md`).

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
| Registering numbers | ✅ Console → Numbers (Phase 3) | — |
| Creating a direct (non-Shopify) merchant | ✅ Console → Tenants → New merchant (Phase 3); the owner requests the sign-in link | — |
| Marking a merchant's DLT PE link | ✅ Console → tenant → DLT card (Phase 3) | — |
| Transfer-number verification | Attestation only | Test call from onboarding (needs the engine) |
| Number answer-rate job (`cli-health`) | ✅ Nightly in the reconcile worker (Phase 3); staff decide retirements in the console | — |
| API reference for Client B | ✅ `docs/api/openapi.json` (generated from the route schemas, drift-checked in CI) and `GET /v1/openapi.json` | Publish a rendered copy at docs.naaradh.com (Phase 5) |
| RTO analytics export (BigQuery) | ✅ Nightly `workers-analytics` load job (Phase 3); no PII in the facts | Baseline/RTO dashboards on top of the dataset (P2-WEB-2) |
| Shopify Flow trigger | Not built | Flow extension (P2-SHOP-7) |
| Voice choice in onboarding | Not built | Needs the engine's voice list |
| Snippet hosting | Served by the web app | `cdn.naaradh.com` (Cloud CDN) |
