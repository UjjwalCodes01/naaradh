# calendar

Appointment booking behind one port, so the agent can offer real times without knowing which
calendar a merchant uses.

- **`src/types.ts`** — the port: list free slots, book, cancel.
- **`src/calcom.ts`** — the Cal.com adapter. `[VERIFY]`: written from the published API and never
  run against a real account (Q-25), so every parser is strict — an unexpected response is
  refused rather than guessed at, and the agent offers a callback instead.
- **`src/fake.ts`** — a deterministic calendar for tests.

The agent may only offer slots the provider actually returned, and may only book against the
caller's own verified number (ADR-0011).
