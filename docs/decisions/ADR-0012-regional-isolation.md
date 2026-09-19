# ADR-0012 — Data residency: one deployment serves one region

**Status:** accepted (the second and third deployments are Phase 6 infrastructure work)
**Date:** 19 Sep 2026
**Deciders:** Founder (implemented by agent, PLAN Phase 6 — P6-INF-1, P6-INF-2, prerequisite for P6-CMP-1)
**Invariants touched:** 1, 2, 8, 15, 16
**Edge cases:** E-142…E-146 below
**Supersedes nothing.** ADR-0004 (Neon, Singapore) stands for the India deployment.

## Context

Phase 6 sells the same product to merchants in the United States and Europe. Their customers'
phone numbers, recordings and transcripts must not sit in Singapore or Mumbai, and a European
merchant's data protection officer will ask exactly where it does sit. The audit before Phase 6 found the *calling* core already region-aware —
windows, consent rules, CLI pools, engine choice and disclosure language all follow the
recipient — and the *data* not region-aware at all: one database, one recordings bucket, one
Pub/Sub project, for every tenant.

There are two ways to fix that: route each request to the right regional store inside one
deployment, or run one deployment per region that only ever sees its own data. This ADR picks
the second, and records what the code must do now so that the first US tenant cannot land in
the wrong place by accident.

## Decisions

1. **One deployment per region, and it serves only that region.** `naaradh-prod-in`,
   `naaradh-prod-us`, `naaradh-prod-eu` are separate Google Cloud projects from the same
   Terraform modules, each with its own database, Redis, Pub/Sub topics, recordings bucket and
   BigQuery dataset. No service ever opens a connection to another region's store. The
   alternative — one deployment with a pool per region — was rejected: every query, queue and
   bucket path would have to carry a region, and one forgotten `withTenant` would move personal
   data across a border silently.

2. **Every service declares the region it serves (`DATA_REGION`), and refuses to work for a
   tenant from another one.** The guard is in three places, so a misrouted request fails loudly
   instead of quietly writing foreign data:
   - the **gate**, step 1: an intent whose tenant is out of region is refused
     `tenant:other_region` — it is never dialled, and the reason is in the trace;
   - **inbound admission**: a call to a number whose tenant is out of region is not answered by
     this deployment; it falls back like any other refusal, never with a guess;
   - the **cross-tenant sweeps** in the workers (checkouts, appointment reminders, QA sampling,
     retention): they filter on `tenants.data_region`, so a foreign tenant's rows are not even
     read.
   Today every deployment is `in` and every tenant is `in`, so nothing changes; the day a second
   region exists, the guard is already there and tested.

3. **A tenant's region is decided once, at provisioning, and never changes.** `dataRegionFor()`
   maps the merchant's country. Moving a merchant between regions is an export, a delete and a
   re-install — not an `UPDATE`. Nothing in the product offers it.

4. **Shopify webhooks and inbound calls are routed at the edge, not in the application.** A
   Shopify app has one webhook URL for every store, and a phone number belongs to one country.
   The load balancer routes on a small, replicated directory (`shop domain → region`,
   `called number → region`) that holds no personal data — a domain, a number and a region.
   Until a second region exists this directory is a single row set in the India deployment and
   the edge is a no-op.

5. **The support line's tenant still comes only from the number that was called** (invariant 16).
   Region routing decides *which deployment* answers; it never decides *which tenant*.

6. **Recordings and transcripts follow the deployment.** `RECORDINGS_BUCKET` is regional by
   construction (one bucket per project, CMEK in that region). The recordings port already
   abstracts the store, so no product code changes.

7. **India stays on Neon (ADR-0004) until Q-16 is answered.** The Singapore caveat is disclosed
   in the privacy policy and the DPA. US and EU deployments choose their own managed Postgres in
   their own region at build time; every database object is vanilla Postgres precisely so this is
   a configuration decision, not a migration project.

## New edge cases

| Id | Case | Behaviour |
|---|---|---|
| E-142 | A tenant's `data_region` does not match the deployment's | Every outbound call is refused `tenant:other_region`; inbound is not answered by this deployment; sweeps skip the tenant |
| E-143 | A US store installs the Shopify app while only the India deployment exists | It installs and is waitlisted (Q-20): a tenant is created with `data_region = us`, no use case is live, and the guard means nothing can call even if one were |
| E-144 | A webhook for a shop in another region reaches this deployment | Verified, stored and processed only if the tenant is in region; otherwise acknowledged and ignored with an audit line — never silently dropped, never acted on |
| E-145 | A staff member opens a foreign tenant in the console | The console is per region too; a tenant that is not in this region is not in this database |
| E-146 | `DATA_REGION` is misconfigured (say `us` on the India deployment) | Every tenant is out of region, so everything is refused loudly on the first dispatch instead of writing foreign data |

## Consequences

- Phase 6's infrastructure work is "run the Terraform again in another project", not "rewrite the
  data layer". The modules already take a region.
- A merchant cannot be served by two regions at once, which is the point.
- Cross-region reporting (how many calls did every region make?) has to aggregate from the
  regional BigQuery datasets, not from one database. That is a reporting job, and it is the
  correct trade for not moving personal data.
- The guard costs one column in a snapshot the gate already loads, so there is no per-call query.

## Amendment 1 — 19 Sep 2026: the edge is the hooks service, not the load balancer

**Implements** decision 4 (P6-INF-2). A load balancer cannot route a Shopify webhook by shop
without reading the body's headers against a directory it does not have, and its URL map cannot
be updated every time a store installs. So:

1. **The directory is a table**, `region_directory (kind, key, data_region, source)` — a
   myshopify domain or one of our own numbers, and a region. No personal data; the key format is a
   database check. Each deployment is the only writer of its own rows (`source`): its reconcile
   worker derives them every 5 minutes from its own installed stores and non-retired numbers,
   applies them locally, and pushes the full snapshot to each peer's
   `POST /internal/region-directory`, signed with **that region's own Ed25519 private key**
   (`REGION_SYNC_PRIVATE_KEY`); peers hold only its public key (`REGION_PEER_KEYS`). The sender
   names itself in a header, the signature is checked against that region's public key before the
   body is parsed, and the snapshot must claim the same region — so a region can publish rows only
   for itself (a shared HMAC key was rejected: whoever can verify with it can also forge). A
   snapshot older than 10 minutes is refused, so a delayed or replayed push cannot roll the
   directory back. A peer never writes over another region's row and releases what the sender
   stopped listing.
2. **Shopify webhooks are forwarded by hooks.** After the HMAC check (invariant 9) and **before
   anything is stored**, a webhook for a shop the directory places in another region is sent to
   that region's hooks byte for byte with Shopify's headers, where it is verified again. The
   receiving region's status is returned to Shopify (a peer failure becomes 502, so Shopify
   retries). A forwarded request carries `X-Naaradh-Forwarded-From` and is never forwarded again.
   The India deployment therefore never holds a US or EU customer's order, even transiently in
   `webhook_events` (E-144). With peers configured, a webhook for a shop **no** region has
   claimed yet (a fresh install before the next sync) is answered 503 without storing anything;
   Shopify retries it, and by then the owning region has published the shop.
3. **Phone numbers need no forwarding.** A number is rented in one region's engine account, whose
   answer URL already points at that region's voice service; the `number` rows exist so the
   support tooling and a future carrier-level router can see where a number lives.

A store that moves regions is unknown for at most two sync passes; Shopify's hourly order
reconcile (E-53) recovers orders acknowledged in between. Operations: `docs/runbooks/region-directory.md`.
