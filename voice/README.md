# voice

The brain during a live call — `voice.naaradh.com`. Synchronous HTTP, never a queue: a person is
waiting on the line, so every response budget here is in hundreds of milliseconds.

**Two jobs:**

- **`/inbound/:vendor`** — a customer dialled one of our numbers and the engine asks who should
  answer. Runs `admitInbound()` and replies with: answer (with the prompt and the tools for this
  tenant), forward to the merchant's own number, or a spoken closed message. Never silence (E-92).
  The tenant comes only from the number that was called (invariant 16).
- **`/tools/:vendor/:tenant/:tool`** — the agent invoked one of our tools mid-call ("look up this
  order", "open a ticket", "cancel it"). Verifies, authorises against the caller's proven
  identity, runs it, records it in `agent_actions` (invariants 17 and 18).

**What does NOT live here:** the words the agent says (`call-scripts/`), the admission rules
(`compliance/`), and the database operations the tools perform (`pipeline/`).

This is the only service that can decrypt a staff transfer number, and it must never hold the
key that decrypts a customer number (AGENTS §4).

Env: `pnpm env:list voice`.
