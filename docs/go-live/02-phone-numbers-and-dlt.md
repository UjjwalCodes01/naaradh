# 2. Phone numbers and DLT

Naaradh never carries voice itself: every call goes out and comes in through a licensed Indian
telecom provider (TSP) or CPaaS, via the voice engine (SPEC §4.1.2, §5). You need two things from
the telecom side — **numbers** and a **DLT registration** — and one answer before buying: which
number series is allowed for AI service calls.

## 1. Ask the telecom providers in writing first

The rules conflict for exactly our main use case (SPEC §4.1.1):

| Series | What TRAI rules say | Our use |
|---|---|---|
| **140xxxxxxx** | Promotional / telemarketing only | Abandoned-cart and other promotional calls (with consent) |
| **1600 / 1601** | BFSI regulators and government only | Not us (BFSI is excluded by our AUP) |
| **10-digit ordinary** | Prohibited for commercial calling | ? — COD confirmation is a *service* call |

That is **Q-01**, and it blocks buying outbound numbers. Send the letter in **SPEC Appendix A** to
at least three providers — Exotel, Plivo and one of Airtel / Jio / Vi enterprise — and store every
reply in `docs/legal/tsp-responses/`. The letter also asks about DND scrubbing on transactional
calls (Q-02), telemarketer registration and PE linking, SIP to a third-party AI engine, per-second
billing, and complaint attribution. Show the replies to the lawyer (Q-01, Q-15).

Until Q-01 is answered in writing, the code does not guess: a number only carries the purposes a
person explicitly writes into `numbers.purpose_allowed`, with the evidence in
`numbers.provisioning_note` (see §5). An intent with no eligible number is refused with
`cli:none_available`, not called from a wrong series.

## 2. What numbers you need

| Number | For | How many | Notes |
|---|---|---|---|
| **Outbound CLIs** (series per Q-01) | COD confirmation, lead callback | Start with 2–3 in a shared pool | Rotated round-robin; retired if the 7-day answer rate falls below 25% (E-28) |
| **140-series CLIs** | Promotional calls only (later) | 1–2 | Only after DLT + PE linkage + templates; promotional is Phase 4 |
| **Support-line number** per merchant | Inbound: the AI answers the merchant's customers | 1 per merchant | The merchant either **forwards** their existing support number to it (carrier call forwarding) or prints the new number on invoices/packaging (PLAN Phase 1B risk note) |
| **Fallback / transfer numbers** | The merchant's own staff phones | Merchant-supplied | Not bought by you; entered by the merchant in the dashboard and encrypted with the staff key |

Channel count (simultaneous calls) is bought from the engine/CPaaS, not per number. Each merchant's
concurrency defaults to 2 (`tenants.max_concurrency`); size channels to the sum of pilot merchants.

**Never** use a foreign CLI (Twilio or any international route) for calls to Indian mobiles — toll
bypass is illegal (SPEC §4.1.2). US/UK numbers come later through Retell (Twilio/Telnyx) for
US/UK customers only.

## 3. DLT registration

TRAI's DLT system links every commercial caller to a registered business (SPEC §3.3):

| Role | Who | Where | Cost (SPEC) | Needed for |
|---|---|---|---|---|
| **Telemarketer — Aggregator** | Naaradh | Any TSP DLT portal (Airtel, Jio, Vi, BSNL) | ₹5,000 + GST, one-time | Placing commercial calls for others (P2-LEG-1) |
| Telemarketer — Delivery | Naaradh, later | Direct operator connection | ₹50,000 + ₹900 | Only if you connect to operators directly |
| **Principal Entity (PE)** | Each merchant | Any TSP DLT portal, with PAN + address proof | ₹5,900 on the first TSP, free after | The merchant is the legal sender |
| **PE ↔ Telemarketer link** | Merchant links to Naaradh | DLT portal | — | Must be active for every commercial call |

What you need: company PAN, GSTIN, CoI, authorised-signatory details and letter of authorisation
`[VERIFY with the portal]`. Rejections for document mismatch are common — make every name and
address match the CoI exactly, and record each rejection and fix (P2-LEG-1).

**In the product today:**

- Merchants enter their **DLT PE ID** in Settings (dashboard) or Setup (Shopify app); it is stored
  on `tenants.dlt_pe_id`.
- Promotional use cases cannot be switched on until a PE ID is on file, and the gate refuses
  promotional calls until the link is confirmed (`tenants.dlt_linked_at`).
- **Gap:** only the service role can set `dlt_linked_at`, and the staff console has no button for
  it yet. Until then staff set it by SQL after checking the link on the DLT portal (see
  [08](08-first-merchants.md#gaps-you-will-hit)).
- A merchant-facing PE registration guide (P2-LEG-2) is still to be written.

Liability note for the terms and the sales conversation: TCCCPR holds the PE (merchant)
vicariously liable for the telemarketer's conduct; a contract does not shield them (SPEC §3.3).

## 4. Buying numbers

Three routes, all needing the **company's** telecom KYC:

1. **Through the engine vendor.** OmniDimension sells +91 numbers after eKYC (PAN + Aadhaar OTP +
   GST, minutes — SPEC §3.2). Ask Bolna the same. Simplest; but get Q-05 answered first — whose
   telecom licence and whose DLT telemarketer ID the calls go out under.
2. **Through a CPaaS** — Exotel or Plivo — with company KYC, then **import** the numbers into the
   engine (both candidate engines support Exotel number import / SIP — SPEC §5.2).
3. **Directly from a TSP** (Airtel IQ, Jio, Vi enterprise) — the route to a Delivery-telemarketer
   set-up later; also who to ask about number series.

For each number record, before you pay: series, carrier, whose licence, whose DLT ID, per-second
billing, inbound capability, and the monthly rental. Keep the invoice (Q-04 evidence).

## 5. Connecting a number to Naaradh

Two places: the engine (where the call physically arrives) and Naaradh's `numbers` table (which
decides who the number belongs to and what it may be used for).

### 5.1 On the engine / CPaaS

| Direction | What to configure | Value |
|---|---|---|
| **Inbound** (support line) | The "answer URL" / inbound-context webhook for the number | `https://voice.naaradh.com/inbound/<vendor>` (stage: `voice.stage.naaradh.com`) |
| Outbound | Nothing per number | Naaradh sends the call-event webhook URL and the tool URLs **with every call** (`/engine/<vendor>/<tenant>.<tag>` on hooks, `/tools/<vendor>/<tenant>.<tag>/<tool>` on voice — tagged with `ENGINE_WEBHOOK_KEY`) |

The exact field names depend on the engine and are finalised with its adapter (ADR-0001).

### 5.2 In Naaradh (today: SQL, by staff)

There is no screen for numbers yet (gap). Staff insert the row with the **service** role against
the environment's database. The number below is a placeholder — never commit a real number.

```sql
-- Pool number for outbound (tenant_id NULL = shared pool; set a tenant id for a dedicated number)
insert into numbers (id, tenant_id, e164, region, series, provider, engine,
                     purpose_allowed, status, provisioning_note)
values ('num_<ULID>', null, '+91XXXXXXXXXX', 'IN', '10digit', 'exotel', 'bolna',
        array['transactional','service']::purpose[],   -- only what the TSP letter allows (Q-01)
        'active',
        'TSP letter 2026-09-xx ref <file in docs/legal/tsp-responses/>');

-- Support line for one merchant: tenant-owned, answered by that merchant's active inbound profile
insert into numbers (id, tenant_id, e164, region, series, provider, engine,
                     purpose_allowed, status, inbound_enabled, inbound_profile_id, provisioning_note)
values ('num_<ULID>', 'ten_<merchant>', '+91XXXXXXXXXX', 'IN', '10digit', 'exotel', 'bolna',
        array[]::purpose[], 'active', true, 'ipr_<active profile>', 'support line for <merchant>');
```

Rules the database enforces: a support number may only be answered by a profile of the tenant that
owns it (trigger `numbers_profile_same_tenant`); the app role cannot insert or change numbers;
merchants only ever see their own and pool numbers (RLS).

How a call uses it:

- **Outbound:** the gate picks an `active` number whose region matches the **recipient**, whose
  engine matches, and whose `purpose_allowed` includes the call's purpose; the tenant's own numbers
  first, then the pool, least recently used first. None → `cli:none_available` (retry in 15 min).
- **Inbound:** the tenant is resolved **only** from the number that was called
  (`resolve_inbound_number()`, invariant 16). The merchant's inbound profile must be `active`
  (Support agent page), and it should have a fallback number so a refusal never means silence.

### 5.3 Number health

Warm new numbers with low volume. The gate skips numbers whose 7-day answer rate is below 25%
(E-28); **the job that computes `answer_rate_7d` is not built yet** (`cli-health`, needs live
numbers), so watch answer rates by hand in the first weeks and set `status = 'retired'` on a
number the carriers flag as spam.

## 6. Checklist

- [ ] Appendix A letter sent to ≥ 3 providers; replies filed; lawyer has read them (Q-01, Q-02, Q-15)
- [ ] DLT Telemarketer (Aggregator) approved; registration ID recorded
- [ ] Outbound numbers bought in the series the letters allow; invoices kept
- [ ] One support-line number per pilot merchant; forwarding plan agreed with the merchant
- [ ] Engine answer URL set for each support number
- [ ] `numbers` rows inserted with `purpose_allowed` + `provisioning_note` evidence
- [ ] Pilot merchants registered as PE and linked to Naaradh (for promotional, later)
