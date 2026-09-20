# shared

Small utilities every other folder uses. **No business rules live here** — if it encodes a
product or regulatory decision, it belongs in `compliance/` or `pipeline/`.

**What lives here:** prefixed ULIDs (`ten_`, `int_`, `att_`…), `NaaradhError` and its codes,
the pino logger with its PII redaction list, phone handling (E.164 validation, HMAC hashing,
encryption), money and time helpers, environment loading and the shared env fragments, request
signing and verification (webhooks, engine URLs, region snapshots), and the reserved fake phone
ranges with the guard that refuses to dial outside them (`src/fake-phones.ts`, shipped because
the simulator calls it at dial time; the per-test numbers are in `test/fake-phones.ts` — real
numbers never appear in this repo, invariant 8).
