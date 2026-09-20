# packages/engines

| Package | Purpose | Status |
|---|---|---|
| `core` | `VoiceEngineAdapter`, `EngineCapabilities`, event types. **The only engine package product code may import.** | done |
| `harness` | Shared contract tests every adapter must pass (13 scenarios, AGENTS.md §10) | P1-ENG-1 |
| `simulator` | Deterministic scripted engine for CI and local dev | P1-ENG-2 |
| `bolna` | India candidate | after ADR-0001 |
| `omnidim` | India candidate (direct API, not OmniRelay) | after ADR-0001 |
| `retell` | US/EU | P6-ENG-1 |

Three vendor packages exist — `bolna` and `omnidim` (India), `retell` (US/EU) — each built from
the vendor's published API and marked `[VERIFY]` until recorded payloads replace the stand-in
fixtures (docs/go-live/03, 10). Which Indian engine is primary remains **ADR-0001**'s decision
(P0-ENG-6); having both adapters lets the bake-off run through Naaradh itself.

Each vendor package ships `client.ts`, `map-events.ts`, `map-errors.ts`, `fixtures/*.json`
(sanitised recorded payloads — fake numbers only) and `contract.test.ts`.

Product code branches on `capabilities()`, never on `vendor`.
