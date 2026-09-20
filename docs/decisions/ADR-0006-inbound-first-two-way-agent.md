# ADR-0006 — Two-way voice agent, inbound first

**Status:** accepted
**Date:** 2026-09-12
**Deciders:** Founder
**Invariants touched:** 1 (scoped to outbound), 7 (extended to inbound), 9 (extended to the voice runtime), 12 (new `inbound` kill-switch scope), 14 (amended: agent-initiated cancellation), new 16–19 (inbound). Billing: new unit (inbound minutes) alongside invariant 11, which is unchanged for outbound.
**Open questions closed:** none. Depends on Q-15 (inbound DLT/CLI treatment in India). Opens Q-17 (inbound pricing), Q-18 (caller-ID reliability on Indian networks).

## Context

SPEC v1.1 §1.2 made Naaradh outbound-only in v1 and put an inbound receptionist in Phase 7.
The founder's product is the opposite emphasis: **a merchant's phone line that an AI answers** —
customers call, the agent resolves their question (order status, delivery, returns policy,
cancellation, address change, callback), and hands off to a person when it should — with the
outbound use cases (COD confirmation, lead callback, …) running on the same agent, numbers,
compliance layer and dashboard.

Three facts shape the design:

1. **An inbound call is the customer's choice.** The outbound gate exists to decide *whether we may
   disturb someone*; for inbound that question does not arise. Different controls apply:
   disclosure, identity before revealing anything, what the agent may *do*, abuse, and cost.
2. **An open conversation needs grounded facts and real actions.** An outbound COD call knows six
   facts. An inbound caller can ask anything, so the agent needs (a) the merchant's knowledge base,
   (b) live data about *this caller's* orders, and (c) tools that act — each one verified, audited
   and bounded on our side, never left to the model's judgement.
3. **Latency.** A mid-call tool call has well under a second of budget before the silence is
   noticeable. That work cannot go through Pub/Sub; it needs a synchronous service.

## Decision

### Product
Naaradh is a **two-way AI voice agent for commerce**. Inbound support is the lead product; outbound
use cases run on the same platform. SPEC §1 is rewritten accordingly (v1.2).

### Architecture — engine-hosted agent, Naaradh-hosted brain
The engine (Bolna / OmniDimension / Retell — ADR-0001) terminates the call, does STT/LLM/TTS, and
calls **our** endpoints at two moments:

| Moment | Endpoint (`voice`, `voice.naaradh.com`) | Budget |
|---|---|---|
| Call arrives on a merchant's number | `POST /inbound/:vendor/:tag` → answer or fall back; returns first utterance, system prompt, tools, variables | < 500 ms p95 |
| Agent needs to know or do something | `POST /tools/:vendor/:tag/:tool` → structured result the agent speaks from | < 700 ms p95 |

`voice` is a new synchronous service. It is not `hooks` (which does no business logic)
and not `api` (merchant-facing auth model). The same tool endpoints serve **outbound** calls,
so "transfer me to the manager" works identically in both directions. Call events (answered,
ended, recording, transcript) still flow through `hooks` → Pub/Sub → `results-consumer`, unchanged.

### Admission instead of the gate (`compliance/inbound`)
`admitInbound()` — pure, ordered, traced like `gateIntent()` — decides **answer with AI** or
**fallback** (forward to the merchant's number, or a polite closed message):

1. number routed to an active inbound profile
2. tenant status (paused/suspended/uninstalled → fallback)
3. kill switch: `inbound:*` → `inbound:<tenant>` (a *global outbound* kill does not stop answering)
4. inbound minute cap for the month
5. concurrency (tenant inbound max, engine max)
6. caller abuse limit: same caller hash > N calls/hour to one tenant → brief message, end
7. engine healthy (breaker closed) → else fallback forward

No consent check, no DND scrub, no 09:00–21:00 window: the customer called. **Transfers** do have
hours — the merchant's.

### Identity before information (new invariant 17)
| Level | How | Allows |
|---|---|---|
| `none` | withheld/unknown caller ID | knowledge base only; create a callback ticket |
| `caller_id` | caller's number hash = order's phone hash | read status of *their* orders; request cancellation of an unshipped COD order |
| `knowledge` | order number + delivery pincode match | everything `caller_id` allows, for that order, from any number |

Caller ID can be spoofed (Q-18), so it never unlocks anything that moves money or changes an
address; those always become merchant tickets.

### Actions the agent can take — server-side, two-step (invariant 14 amended)
The model never mutates anything. It asks `voice` to, and the service decides:

- **Cancel an order** (the founder's "cancel after two confirmations"): step 1 returns a readback
  ("order #1001, ₹499, 2 kurtas") and a single-use token; the agent must read it back and get a
  second yes; step 2 with the token executes **only if** the tenant enabled agent cancellation,
  identity ≥ `caller_id` for that order, the order is COD, unfulfilled and not already cancelled.
  Otherwise it becomes a merchant ticket. Prepaid orders always go to the merchant (refund = money).
- **Address change** → always a ticket for the merchant (E-44 unchanged).
- **Transfer** → only to a verified, active `transfer_targets` row, inside its hours; the caller
  never supplies a number (toll fraud, E-30).
- **Callback / ticket** → `support_tickets`, visible to the merchant, merchant webhook emitted.
- **Opt-out** said on an inbound call → tenant suppression for *outbound* (invariant 6 unchanged).

Every tool call is an `agent_actions` row (append-only, PII-scrubbed args) — the record of what the
agent did and why.

### Knowledge
`knowledge_articles` per tenant (title, body, locale, published), searched with Postgres full-text
search. No embeddings vendor in v1; the port allows swapping in vector search later. The agent may
state only what an article or a tool result says (same anti-invention rule as outbound scripts).

### Order data
Naaradh keeps a minimal **order cache** (`orders`) from Shopify webhooks already received: number,
status, total, item summary, fulfilment/tracking, phone hash, pincode hash — no names, no
addresses. Live Shopify lookups replace/augment it when the Admin GraphQL client lands.

### Billing (Q-17)
Inbound is metered **per connected minute** into `billing_ledger` (`kind = 'minute'`, rounded up
per call to the next minute — the pessimistic assumption until Q-04 is answered). Price per plan is
`[DECISION — founder to confirm]`. Invariant 11 is unchanged: outbound outcome billing remains the
five outcomes; inbound calls produce outcomes (`resolved`, `ticket_created`, …) that are never
outcome-billed.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Keep inbound in Phase 7 (SPEC v1.1) | Smaller v1 | Not the product the founder is building |
| **Engine-hosted agent + our tool/context endpoints** | Uses the engines' telephony, barge-in and latency work; our code owns data, identity and actions | Two latency-bound endpoints to run; each engine's tool-call format needs mapping (adapter) |
| Self-hosted media (LiveKit/Pipecat) | Full control | 2–4 months of voice engineering; SPEC §5.2 defers to ≥ 50k min/month |
| Let the model call Shopify directly | Less code | Model holds credentials, no identity gate, no audit — unacceptable |

## Consequences

- New app `voice`; new tables `inbound_profiles`, `knowledge_articles`, `orders`,
  `support_tickets`, `agent_actions`, `order_actions`; enum values for inbound outcomes and the
  `inbound` kill scope (migrations 0003–0004). Migration 0005 makes `call_attempts.contact_id` /
  `phone_hash` nullable for inbound only (a withheld caller has neither; the
  `call_attempts_party_known` check keeps outbound rows complete) and adds
  `agent_actions.tool_call_id` so an engine retrying a tool call is answered from the stored
  result instead of acting twice.
- Transfer-target numbers are encrypted with a **separate staff key pair**: `voice` can
  decrypt a manager's number to transfer to it, but can never decrypt a customer number.
- The Phase 0 bake-off (ADR-0001) must score **inbound + mid-call tools** — both Bolna and
  OmniDimension claim them; neither is confirmed until tested on real Indian numbers.
- PLAN is re-sequenced: inbound is Phase 2, the public Shopify app follows it.
- `[OPEN]` Q-15 still governs India: whether an AI answering a 10-digit virtual number, and a
  transfer leg to a merchant's staff, carry any DLT/TCCCPR obligation. Built behind the conservative
  defaults above until answered.

## Rollback

Inbound is additive. Disabling it is `inbound:*` in the kill switch (numbers fall back to the
merchant's forward number) and `numbers.inbound_enabled = false`. Tables can stay; nothing in the
outbound path depends on them.
