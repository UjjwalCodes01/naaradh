# ADR-0015 — When and how to evaluate a self-hosted voice engine

**Status:** proposed — the evaluation is gated on volume; this records the gate and the method so
the decision is made on measurements, not enthusiasm
**Date:** 28 Sep 2026
**Deciders:** Founder (drafted by agent; P7-ENG-1)
**Invariants touched:** 7, 9, 13 (and every compliance invariant, which must survive unchanged)
**Builds on** ADR-0013 (adapters before the bake-off) and ADR-0014 (we rent the call, never the
record).

## Context

Naaradh rents the voice pipeline — speech-to-text, the model's turn, text-to-speech and the carrier
leg — from Bolna, OmniDimension and Retell, behind `VoiceEngineAdapter`. At low volume that is
clearly right: a vendor's per-minute price buys years of work on latency, barge-in and telephony
that a small team should not redo.

At high volume the margin math changes. A self-hosted pipeline — an open-source agent framework
(LiveKit Agents or Pipecat), an Indian-language speech provider (Sarvam, for Hindi and Hinglish),
and a SIP trunk from an Indian carrier (Exotel) — costs roughly the sum of its parts instead of a
vendor's marked-up bundle. The plan names ≥ 50,000 minutes a month as the point where that
difference could pay for the engineering.

Until then, any time spent here is time not spent on merchants.

## Decision

**Do not build a self-hosted engine now.** Start the evaluation only when both hold for two
consecutive months:

1. **≥ 50,000 connected minutes a month** across all Indian tenants, and
2. **engine cost ≥ 40% of revenue** on those minutes — the point where a cheaper engine moves the
   business, not just the spreadsheet.

When the gate opens, the evaluation is a **fourth adapter**, `engines/selfhosted`, run through the
same machinery as every other engine. Nothing in product code changes; that is what ADR-0013's
adapter boundary is for.

## How the evaluation is run

**1. The same contract.** `engines/selfhosted` must pass the shared contract suite
(`pnpm test:contracts`) before it carries a single call — the same scenarios, the same capability
flags, the same `[VERIFY]` discipline. A capability it cannot yet do is declared off, exactly as
Retell's were.

**2. The same bake-off.** The P0 bake-off harness and scoring sheet, on the same scripted scenarios,
the same networks (Jio, Airtel, Vi on 4G), the same Hinglish test set. Measured on a handset, not
in a log:

| Measure | Pass bar |
|---|---|
| Response latency, p50 / p95, heard on the handset | no worse than the incumbent engine |
| Mid-call tool round trip inside the 700 ms budget (E-93) | p95 within budget |
| Barge-in: caller interrupts, agent stops | no worse than the incumbent |
| Hinglish word error rate on the test set | no worse than the incumbent |
| AI + recording disclosure spoken first, every call (invariant 7) | 100% — any miss fails the engine |
| Answering-machine detection accuracy (E-24) | no worse than the incumbent |
| Call setup failure rate over 1,000 test calls | ≤ the incumbent's |

**3. A shadow period.** Once it passes, route a small share of one consenting tenant's traffic
through it with the incumbent as automatic failover (the circuit breaker already does this per
engine). Two weeks minimum, with weekly transcript QA.

**4. The full cost, not the list price.** The comparison that decides:

```
self-hosted cost per minute =
    speech-to-text + text-to-speech + LLM tokens + SIP trunk minutes
  + compute (agent workers sized for peak concurrency, not average)
  + (on-call and maintenance hours per month × loaded hourly cost) ÷ minutes per month
```

The last line is the one that sinks most self-hosting plans. If it is not written down with a real
number, the evaluation is not finished.

**5. The ADR that follows.** The result is a new ADR — accepted or rejected — carrying the measured
table, the cost comparison at current and 2× volume, and the failover plan. This ADR only sets the
gate and the method.

## What does not change, whatever the result

- Compliance stays in `compliance/`, above the adapter. A self-hosted engine gets no shortcut
  around `gateIntent()` or `admitInbound()`.
- ADR-0014 holds: the engine carries the call; the record — recordings, transcripts, outcomes,
  consent — stays in our database and bucket.
- Recordings and transcripts would now be produced on our own infrastructure, which **widens** the
  data we process directly. Re-check the DPA, the sub-processor list and the SOC 2 scope
  (`docs/security/soc2-readiness.md`) before the shadow period, not after.

## Consequences

- No engineering is spent on self-hosting before it can pay for itself.
- When it can, the decision is made on a like-for-like measurement, with the failure mode (fall
  back to a rented engine) already built.
- If the gate never opens, this ADR costs nothing.
