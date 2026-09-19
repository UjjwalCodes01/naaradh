# Architecture decision records

One file per decision: `ADR-<4 digits>-<kebab-title>.md`. Forward-only — a superseded ADR is never edited or deleted, it gets a `Superseded by` line and a new ADR is written.

`CLAUDE.md` requires an ADR for any change to: **engine choice, billing unit, gate semantics, data residency**. `AGENTS.md §4` adds: any Postgres enum value that affects billing or gating, and any new Shopify scope.

## Index

| ADR | Title | Status | Phase |
|---|---|---|---|
| 0001 | India voice engine (Bolna vs OmniDimension) | planned — needs bake-off data | P0-ENG-6 |
| 0002 | CLI `purpose_allowed` defaults and DND-on-transactional | planned — blocked on Q-01, Q-02 | P3-LEG-4 |
| 0003 | Outcome pricing after pilot validation | planned | P4-GTM-3 |
| 0004 | [Neon as the managed Postgres](ADR-0004-neon-postgres.md) — pooled/direct URLs, `app_tenant_id()` RLS, Singapore residency caveat | accepted | P1-CORE-1 |
| 0005 | [Dispatch scheduling: Postgres queue with SKIP LOCKED](ADR-0005-dispatch-scheduling.md) | accepted | P1-CORE-6 |
| 0006 | [Two-way voice agent, inbound first](ADR-0006-inbound-first-two-way-agent.md) — admission, identity levels, server-side tools, two-step cancellation, per-minute inbound billing | accepted | P1B |
| 0007 | [Shopify app on the React Router template](ADR-0007-shopify-app-react-router.md) — Polaris web components, our own encrypted session table, webhooks stay on hooks | accepted | P2-SHOP-1 |
| 0008 | [Billing implementation](ADR-0008-billing-implementation.md) — plan catalogue, included allowances, `billing_postings` outbox, capped / frozen, disputes | accepted | P2-BILL |
| 0012 | [Regional isolation](ADR-0012-regional-isolation.md) — one deployment per region, `DATA_REGION` enforced in the gate, inbound admission and every cross-tenant sweep; region set once at provisioning; edge routing for webhooks and numbers | accepted | P6-INF-1 |
| 0010 | [Promotional calling](ADR-0010-promotional-calling.md) — abandoned checkouts cached then swept, consent only from Naaradh's own checkbox, DLT template per promotional script, promotional-only pause, recovery attribution measured not billed, weekly QA sample | accepted (recovery billing: proposed) | P4 |
| 0011 | [Non-Shopify sources and appointments](ADR-0011-non-shopify-sources-and-appointments.md) — one cart-ingestion contract for every platform, the WooCommerce plugin, a calendar port with Cal.com, `get_slots`/`book_slot`, appointment consent and reminders | accepted (Cal.com payloads `[VERIFY]`) | P5 |
| 0009 | [Merchant surfaces](ADR-0009-merchant-surfaces.md) — magic-link dashboard sign-in, SECURITY DEFINER pre-tenant access, roles, staff console behind IAP, Shopify install provisioning, number reveal deferred | accepted | P2-WEB-1, P2-SHOP-1 |

## Template

```markdown
# ADR-0000 — Title

**Status:** proposed | accepted | superseded by ADR-XXXX
**Date:** YYYY-MM-DD
**Deciders:**
**Invariants touched:** (CLAUDE.md numbers, or "none")
**Open questions closed:** (Q-xx from docs/open-questions.md, or "none")

## Context
What forced a decision. Link the evidence — vendor invoice, TSP letter, benchmark table, regulator text. No claim without a source.

## Options considered
| Option | Pros | Cons |
|---|---|---|

## Decision
What we chose, stated so an engineer can implement it without re-reading the context.

## Consequences
What this makes easy, what it makes hard, what it costs, and what would make us revisit it.

## Rollback
How to undo this if it turns out wrong, and what becomes unrecoverable.
```
