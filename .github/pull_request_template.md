<!--
Required by AGENTS.md §16. A PR that touches calls, compliance, billing or scripts and
leaves these blank does not get reviewed.
-->

## What changed

<!-- One paragraph. What behaviour is different after this merges? -->

## Invariants touched

<!--
List the CLAUDE.md invariant numbers this PR affects, or "none".
1 gate 2 recipient-region 3 IST window 4 30-min transactional 5 promotional consent
6 suppressions 7 disclosure 8 no raw PII 9 webhook verification 10 idempotency
11 billable outcomes 12 kill switches 13 engine adapter boundary 14 auto-write confidence
15 RLS
-->

- [ ] No invariant is weakened by this change.

## Edge cases covered by tests

<!-- E-xx ids from docs/NAARADH_BUILD_SPEC.md §12, with the test name for each. -->

| E-xx | Test |
| --- | --- |
|  |  |

## Tests

- [ ] Unit
- [ ] Integration (Testcontainers) where state or RLS is involved
- [ ] **At least one negative compliance test** if a gate was touched
- [ ] `pnpm test:compliance` green
- [ ] Boundary tests where a window or deadline changed (08:59 / 09:00 / 20:59 / 21:00 IST,
      `event_ts + 29m59s` / `+30m01s`)

## Open dependencies

<!-- Q-xx from docs/open-questions.md, or [LEGAL] items this depends on. State the flag and
     the conservative default used in the meantime. -->

## Data and migrations

- [ ] New tenant table has an RLS policy **in this migration**
- [ ] Append-only table has no UPDATE/DELETE grant
- [ ] New PII-capable column added to the logger redact list and the erasure job
- [ ] Down-migration notes below (notes, not code — migrations are forward-only)

## Docs

- [ ] ADR in `docs/decisions/` if a decision changed
- [ ] Runbook in `docs/runbooks/` if an operator has to act
- [ ] New `E-xx` added to the spec if this PR discovered one

## Rollback plan

<!-- How to undo this, and what becomes unrecoverable once it ships. -->
