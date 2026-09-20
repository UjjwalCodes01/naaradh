# ADR-0013 — Engine adapters are built before the bake-off, and unsigned vendors are first-class

**Status:** accepted
**Date:** 20 Sep 2026
**Deciders:** Founder (implemented by agent; P1-ENG-3, P1B-ENG-1, P6-ENG-1)
**Invariants touched:** 1, 7, 9, 10, 13, 16
**Does not supersede ADR-0001**, which still decides *which* Indian engine is primary.

## Context

The plan was to write one Indian adapter after the bake-off picked a winner. That left the
whole product unable to place a call until a decision that itself needs calls to be placed. The
vendors publish complete API references, so the adapters can be written first, exactly as
Retell's was, and the bake-off can run through Naaradh instead of through vendor dashboards.

Reading those references showed something the engine contract had assumed away: **neither
Bolna nor OmniDimension signs its webhooks**, OmniDimension reports a call only once it is over
and cannot be asked about a call by our key, and Bolna answers inbound calls with one fixed
agent per number.

## Decisions

1. **`packages/engines/bolna` and `packages/engines/omnidim` exist now**, written from the
   published APIs with every assumption marked `[VERIFY]` and stand-in fixtures. An adapter is
   "verified" only when recorded, sanitised payloads replace the stand-ins (go-live 03 §5).
2. **For an unsigned vendor the webhook is only a doorbell.** `EngineCallSnapshot.result`
   carries the outcome, transcript, recording link and cost as fetched from the vendor's API;
   the results worker writes outcomes and billing from it, never from the body (invariant 9).
   The claimed call id must be the one the dispatcher recorded, and where the vendor's record
   names our attempt it must name this one. A mismatch is audited and alerted. The same record
   lets the reconciler finish a call whose webhook never came with its **real** outcome (E-21),
   instead of closing it inconclusive.
3. **Capabilities say what a vendor cannot do; product code branches on them, never on the
   vendor.** Added: `progressEvents` (no ringing/answered events) and `callLookup` (a call
   cannot be found by our idempotency key). Without `callLookup`, an uncertain dispatch is not
   re-dialled until the longest possible call has passed with no webhook (invariant 10).
   Tools are not offered to an engine without `midCallTools`; a transfer is not promised by one
   without `warmTransfer`.
4. **`parseWebhook` may return null** for a verified delivery that says nothing we track, so a
   vendor that posts on every status change is acknowledged rather than answered with errors.
5. **Bolna inbound keeps invariant 16 by signing the called number into the lookup URL** we give
   Bolna when a number is attached (`inboundLookupPath`, `inbound:attach`). The number's agent has
   a prompt and greeting that are pure variables, filled per call from our admission decision.
   It ships **switched off** (`BOLNA_INBOUND`), because none of it has been seen working, and it
   cannot forward a refused call to the merchant's number — a refusal speaks the closed message
   (never dead air, E-92). Both are recorded as Q-34.
6. **Secrets that are not signatures**: Bolna's tool calls and caller lookups authenticate with
   a static bearer we issue (`BOLNA_TOOL_TOKEN`) plus the tenant tag in the URL. Webhook URLs
   stay tenant-tagged, and Cloud Armor should allow only the vendor's published source IPs.

## Consequences

- Going live in India is now accounts, numbers and verification calls — not an adapter project.
- OmniDimension can carry outbound confirmation calls only (no tools, no support line, Q-35).
- A wrong assumption about a vendor's payload fails safe: an unparseable record is
  inconclusive and unbilled, and the contract suite turns red the day real fixtures go in.
