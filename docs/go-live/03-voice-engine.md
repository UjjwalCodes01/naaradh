# 3. Voice engine

The engine rents Naaradh its ears, voice and phone line: speech-to-text, the LLM turn-taking,
text-to-speech and the PSTN connection (SPEC §5.1). Naaradh keeps everything around it — who may
be called, identity, tools, knowledge, outcomes, billing. Product code only talks to
`VoiceEngineAdapter`; a vendor is plugged in by writing one adapter package (invariant 13).

**All three vendor adapters are built** — Bolna and OmniDimension for India, Retell for US/EU —
each written from the vendor's published API (Sep 2026) and **none yet run against a real
account**: every assumption is marked `[VERIFY]` in `packages/engines/<vendor>/src`, and the test
fixtures are stand-ins, not recordings. What is left is linking accounts, the verification calls
in §5, and ADR-0001's choice of which Indian engine is primary.

| | Bolna | OmniDimension | Retell (US/EU) |
|---|---|---|---|
| Outbound calls | yes | yes | yes |
| Mid-call tools (order lookup, tickets, cancel) | yes, with `BOLNA_TOOL_TOKEN` | **no** — custom APIs exist only in its dashboard | yes |
| Support line (inbound) | built, **off** until verified (`BOLNA_INBOUND`, Q-34); a refusal speaks the closed message — it cannot forward to the merchant's number | no | no (Q-31) |
| Warm transfer to a number chosen per call | no — becomes a callback ticket | no | no |
| Cancel a queued call | yes | no | no |
| Webhooks signed | **no** (source IPs) | **no** | yes |
| Live progress events (ringing, answered) | yes | no — one post-call webhook | yes |

Because Bolna and OmniDimension sign nothing, the webhook is only a hint: the outcome, transcript,
recording and cost are written from the call record **fetched back from the vendor's API** (E-23),
the dispatched call id must match, and Cloud Armor should allow only the vendor's source IPs
(`engine_ip_allowlist`). OmniDimension is therefore a fit for outbound confirmation calls only;
the support line needs Bolna (or whichever engine the bake-off shows can do it).

## 1. Candidates (SPEC §5.2, prices `[VERIFY]`)

| Vendor | Use | Why |
|---|---|---|
| **Bolna** | India primary candidate | India-first; Hindi/Hinglish; works with Exotel/Plivo/Twilio; inbound, transfer, custom-API tools |
| **OmniDimension** (direct API, not OmniRelay) | India secondary candidate | +91 numbers via eKYC; Exotel import; SIP; no DLT mention in its docs — compliance is on us |
| **Retell** | US/EU (later), and a reference in the bake-off | Strong transfer and tools; weak India depth |

Rejected: CALL-E (no inbound or cancel; India only via an international line), OmniRelay
(margin stack).

## 2. Sign up (P0-ENG-1)

For each of Bolna, OmniDimension and Retell:

1. Create an account with a company email (naaradh.com Workspace) and turn on 2-factor auth.
2. Fund the minimum wallet; note the billing currency (INR with GST, or USD — Q from §5.4 item 11).
3. Create an API key — store it in a password manager now, in Secret Manager later
   (`BOLNA_API_KEY`, `OMNIDIM_API_KEY`, `RETELL_API_KEY`). Never in the repo or a shared doc.
4. Find where the vendor configures: webhook signing secret, per-call webhook URL, inbound
   "answer" URL, custom tool/function calling, tool timeout, transfer, recording and transcript
   delivery. You will need these for the adapter.
5. Send the **15 questions in SPEC §5.4** in writing (P0-ENG-5) and keep the answers with the
   bake-off sheet. The ones that can end a candidate: per-second billing (Q-04), whose telecom
   licence and DLT ID the calls use (Q-05), signed webhooks, and mid-call tool latency.

## 3. Run the bake-off (P0-ENG-1B, P0-ENG-3)

Run the same scenarios on each engine, on real **Jio, Airtel and Vi** handsets, recording every
call and filling the Appendix B sheet (`vendor | scenario_id | network | answered_by_detected |
answered_by_actual | first_response_ms | intent_understood_1to5 | naturalness_1to5 |
extraction_correct | disclosure_spoken | duration_sec | billed_sec | cost_inr | notes`).

- **Outbound (20 scenarios, SPEC §15.1):** clear yes; clear no; "kaun bol raha hai?"; asks for a
  human; wrong person; child answers; background noise; Hindi only; English only; Hinglish switch
  mid-sentence; constant interruptions; long silence; asks to change address; asks for a
  discount; "are you a robot?"; asks to stop calling; voicemail; busy; number off; regional
  accents. Indoor and outdoor. Same script on every engine — v0 with the mandatory disclosure
  opening (P0-ENG-2) is in the `packages/scripts` templates (`COD_CONFIRM_HI_IN`,
  `COD_CONFIRM_EN_IN`).
- **Inbound (15 scenarios, ADR-0006):** order status by caller ID, verification by order number +
  pincode, "cancel my order" two-step, FAQ with and without an article, "talk to a person" in and
  out of hours, withheld caller ID, Hinglish switch, interrupting while a tool runs. Point the
  engine's inbound webhook and tools at a **staging** `apps/voice`. Measure tool round-trip p50/p95
  **as heard on the handset**. An engine that cannot run a mid-call tool in about 1 second is out
  for inbound.
- **Billing:** read `billed_sec` from the vendor's **invoice or CDR**, not its docs (P0-ENG-4).

Pass bars (Phase 0 exit): extraction accuracy ≥ 85% on real numbers; per-second billing confirmed.
Kill criterion: below 85% on every engine, or no per-second billing → pause and re-choose
(PLAN Phase 0).

## 4. Decide (P0-ENG-6)

Write `docs/decisions/ADR-0001-india-engine.md` with the sheet attached: primary and secondary
India engine, why, cost per 45-second call, and the answers to Q-04, Q-05 and Q-13 (Hinglish
quality). Then close those questions in `docs/open-questions.md`.

## 5. Link the account and verify the adapter

Per vendor, on **staging**, with a team member's phone as the customer:

1. **Secrets** ([07](07-secrets-and-configuration.md)): the API key (`BOLNA_API_KEY` /
   `OMNIDIM_API_KEY`); for Bolna also `BOLNA_TOOL_TOKEN` (`openssl rand -hex 32`). List them in
   `enabled_optional_secrets`.
2. **Plain env** (tfvars `common_env`): `ENGINE_DEFAULT_IN` (and `ENGINE_SECONDARY_IN`),
   `BOLNA_TELEPHONY_PROVIDER` (the Plivo/Exotel account connected to Bolna), and voices per locale
   from the vendor's voice list — `BOLNA_VOICES` / `OMNIDIM_VOICES` (the built-in defaults are
   English ElevenLabs voices; Hindi needs a Sarvam or similar voice).
3. **Numbers**: buy/import them in the vendor's account, then add them in the console with
   `engine = bolna|omnidim`. Naaradh never dials from a number that is not on the account.
4. **Webhook source IPs**: set `engine_ip_allowlist` to the vendor's published IPs (Bolna's are
   in `prod-in.tfvars`), since the webhooks are unsigned.
5. **Verification calls** — one per scenario: confirmed, cancelled, no answer, busy, voicemail,
   customer hangs up, opt-out, max duration, and (Bolna) one tool call. For each, save the raw
   webhook bodies and the fetched record, sanitise them (fake numbers, no names, no recordings)
   and replace the stand-ins in `packages/engines/<vendor>/test/fake-*.ts`. Settle every
   `[VERIFY]`, in particular:
   - Bolna: `{variable}` substitution in the welcome message and in tool parameters
     (`execution_id`, `naaradh_attempt_id`); what a tool call's body looks like and whether Bolna
     retries it; whether `recording_url` needs the API key; `hangup_by`/`hangup_reason` values;
     `total_cost` currency; that `bypass_call_guardrails` stops Bolna rescheduling a call; the
     shape of `extracted_data` for dispositions; whether literal `{…}` in a prompt is mistaken
     for a variable.
   - OmniDimension: that `call_context` fills `{{slots}}` in the welcome message; the post-call
     webhook body and that `metadata` is echoed; `trigger_call_statuses` delivers no-answer and
     busy; `call_request_id` on call logs; cost units; time zone of timestamps.
6. **Bolna support line** (only after the above): set `BOLNA_INBOUND=true`, assign the number to
   the tenant and its inbound profile in the console, then
   `NUMBER_E164=+91… pnpm --filter @naaradh/workers inbound:attach`. Call the number: the
   greeting must be the profile's disclosure, order lookup must work, and a paused tenant must
   hear the closed message. Check what the caller hears if our lookup URL is down — if it is
   silence or a raw `{placeholder}`, keep inbound off and raise it with Bolna (Q-34).
7. Run `pnpm test:contracts`, then the dev-store matrix in [04](04-shopify-app.md) on the real
   engine. Stage first; production after the pilot checks pass.

## 6. What the engine must be configured with

Per call, Naaradh sends: the webhook URL for call events (hooks), the tool URLs (voice), the first
utterance with the AI + recording disclosure, the system prompt, variables, max duration and AMD
mode. Per number, only the inbound answer URL is set in the vendor dashboard (see
[02](02-phone-numbers-and-dlt.md#51-on-the-engine--cpaas)). Recordings are copied into our own
GCS bucket within minutes of the call; vendor recording URLs are never shown to merchants (E-34).

## 7. Checklist

- [ ] Accounts + API keys for Bolna, OmniDimension, Retell (2FA on)
- [ ] 15 vendor questions answered in writing
- [ ] Outbound + inbound bake-off run on Jio/Airtel/Vi; sheet filled; invoices kept
- [ ] ADR-0001 written; Q-04/Q-05/Q-13 closed
- [ ] Verification calls recorded; fixtures replaced; every `[VERIFY]` settled; `pnpm test:contracts` green
- [ ] Engine key in Secret Manager; `ENGINE_DEFAULT_IN` set for stage, then prod
