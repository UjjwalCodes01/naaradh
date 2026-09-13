# packages/engines

| Package | Purpose | Status |
|---|---|---|
| `core` | `VoiceEngineAdapter`, `EngineCapabilities`, event types. **The only engine package product code may import.** | done |
| `harness` | Shared contract tests every adapter must pass (13 scenarios, AGENTS.md §10) | P1-ENG-1 |
| `simulator` | Deterministic scripted engine for CI and local dev | P1-ENG-2 |
| `bolna` | India candidate | after ADR-0001 |
| `omnidim` | India candidate (direct API, not OmniRelay) | after ADR-0001 |
| `retell` | US/EU | P6-ENG-1 |

No vendor package exists yet, deliberately: the India engine is undecided until the Phase 0
bake-off produces **ADR-0001** (P0-ENG-6). Picking one now would be guessing at the answer to
the question the bake-off exists to settle.

Each vendor package ships `client.ts`, `map-events.ts`, `map-errors.ts`, `fixtures/*.json`
(sanitised recorded payloads — fake numbers only) and `contract.test.ts`.

Product code branches on `capabilities()`, never on `vendor`.
