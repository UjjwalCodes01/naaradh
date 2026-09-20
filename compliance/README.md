# compliance

The answer to one question: **may we place this call?** Kept in one folder so it cannot be
answered two different ways.

**What lives here:**

- `src/gate/` — `gateIntent()`, the thirteen ordered checks every outbound call passes before it
  can be dialled (invariant 1): suppressions, consent, calling windows, attempt limits,
  concurrency, caller-ID choice, kill switches, spend caps. Every refusal has a stable reason
  string (`src/gate/reasons.ts`) the dashboard explains to the merchant.
- `src/inbound/` — `admitInbound()`, the same idea for incoming calls.
- calling windows per country and purpose, public holidays, recording-consent rules
  (`src/constants.ts`, `src/gate/windows.ts`, `src/gate/holidays.ts`).
- the consent ledger, suppression lookups, do-not-call screening, complaint counters.

**Rules for this folder:** never read the clock (take the instant as an argument) and never do
date arithmetic — windows are computed with luxon in the recipient's own time zone. Lint enforces
both. Never loosen a check to make a test pass: if a compliance test fails, the code is wrong, or
the rule changed and needs a decision record.

`pnpm test:compliance` must pass before any merge.
