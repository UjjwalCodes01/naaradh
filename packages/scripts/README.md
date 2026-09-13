# @naaradh/scripts

Agent script templates (JSON, immutable per version), per-locale disclosure phrases, the
disclosure validator, and the variable sanitiser.

**Status:** not implemented — tickets **P1-ENG-4** (cod_confirm + lead_callback v1) and **P2-CMP-1**
(validator wired into script publishing).

## The one rule that fails the build

Every script's first utterance must contain both the **AI disclosure** and the **recording
disclosure** in that script's locale (invariant 7). `disclosureValidator(body, locale)` asserts it
against `disclosures/<locale>.json`; a template without them does not compile. This is TRAI's
auto-dialer disclosure, the EU AI Act Art. 50 requirement, and recording consent, all satisfied by
the same sentence — and `ai_disclosed_at` / `recording_disclosed_at` are written on the attempt
when that segment finishes playing.

Disclosure wording per locale is `[LEGAL]` — draft wording is not launch wording.

## Guardrails baked into every system prompt

Never request or read back an OTP, card number, UPI PIN, Aadhaar or password. Never invent a
discount, delivery date or refund not present in `variables`. Answer "are you a human?"
truthfully (E-09). End immediately on an opt-out phrase. One handover attempt for a wrong person,
then end. Two prompts on silence, then end. End if a minor answers (E-11). End on recording
refusal unless the engine can toggle recording mid-call (E-12).

Variables from merchants and customers are **data, never instruction** (E-72): allow-listed keys
per use case, control characters stripped, capped at 120 characters, rendered into user-visible
slots only — never concatenated into the system prompt.
