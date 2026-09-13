# 3. Voice engine

The engine rents Naaradh its ears, voice and phone line: speech-to-text, the LLM turn-taking,
text-to-speech and the PSTN connection (SPEC §5.1). Naaradh keeps everything around it — who may
be called, identity, tools, knowledge, outcomes, billing. Product code only talks to
`VoiceEngineAdapter`; a vendor is plugged in by writing one adapter package (invariant 13).

**Today only the simulator adapter exists.** Setting `ENGINE_DEFAULT_IN=bolna` makes the registry
refuse with "adapter is not implemented — blocked on ADR-0001". That is deliberate: the adapter is
written for the engine that wins the bake-off, from its real payloads.

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

## 5. After the decision — code work

An engineer builds `packages/engines/<vendor>` (P1-ENG-3, P1B-ENG-1), typically 1–2 weeks:

| Piece | What |
|---|---|
| `client.ts` | HTTP client: place call, fetch call, cancel, find by idempotency key |
| `map-events.ts`, `map-errors.ts` | Vendor webhooks → Naaradh events; vendor errors → retryable / not |
| `map-inbound.ts` | Inbound context request and tool calls → Naaradh shapes; our answers → vendor format |
| Signature verification | Every vendor request verified before parsing (invariant 9); unsigned events are re-fetched (E-23) |
| `fixtures/*.json` | **Sanitised** recorded payloads from the bake-off (no real numbers — lint:pii) |
| `contract.test.ts` | Passes the shared harness (outbound + inbound scenarios) like the simulator does |
| Registry | Case in `packages/engines/registry`; env key already exists (`BOLNA_API_KEY` …) |

Then per environment: add the API key as a secret version, list it in
`enabled_optional_secrets`, set `ENGINE_DEFAULT_IN=<vendor>` (and `ENGINE_SECONDARY_IN`) in the
env's `common_env`, and apply (see [05](05-cloud-infrastructure.md) and
[07](07-secrets-and-configuration.md)). Stage first; production after the pilot checks pass.

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
- [ ] Adapter built and passing the contract harness
- [ ] Engine key in Secret Manager; `ENGINE_DEFAULT_IN` set for stage, then prod
