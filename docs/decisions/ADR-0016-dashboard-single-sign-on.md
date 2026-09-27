# ADR-0016 — Dashboard single sign-on: a per-tenant link, no user creation, owners keep the email link

**Status:** accepted
**Date:** 28 Sep 2026
**Deciders:** Founder (implemented by agent; P7-ENT-1)
**Invariants touched:** 15 (tenant isolation)
**Amends ADR-0009** (dashboard sign-in by magic link), which remains the default.

## Context

Enterprise merchants want their staff to sign in to the dashboard through their own identity
provider — Okta, Microsoft Entra ID, Google Workspace — so that leaving the company removes access
everywhere at once. The standard is OpenID Connect.

Single sign-on is also the most common place a SaaS product gets account takeover wrong. The
failure modes are well known and each one shaped a decision below.

## Decision

OpenID Connect, authorization code flow with PKCE, one provider per tenant, configured by an owner
in the dashboard. Code: `pipeline/src/sso.ts`, `web/src/app/auth/sso/`, migration 0017.

### 1. A per-tenant link, not discovery by email domain

People reach their provider through a link the owner shares — `/auth/sso/start/<slug>`, where the
slug is 16 random characters — or by pasting that code on the sign-in page.

We deliberately do **not** look up the provider from the domain of an email someone types.
Discovery by domain lets any tenant claim any domain: a hostile account registers `bigcorp.com`,
and the next BigCorp employee who types their address is sent to a look-alike sign-in page the
attacker controls. Preventing that needs DNS domain verification. The link needs nothing, lists no
tenants, and cannot be claimed by anyone else.

If a customer ever needs domain discovery, it comes with DNS TXT verification and one verified
owner per domain — never without.

### 2. Single sign-on never creates users

A verified identity signs in a person the tenant already invited, matched by email, or nobody.
There is no just-in-time provisioning. So a misconfigured or hostile provider can at most sign in
that tenant's own invited users, and never reach another tenant: the database function that opens
the session (`open_sso_session`) re-checks the tenant, the user and the domain itself.

### 3. The email is trusted only when the provider vouches for it

The ID token must carry `email_verified: true` — or, for Microsoft Entra ID, `xms_edov: true`.
Entra's plain `email` claim can be edited by the user in some configurations; trusting it is the
"nOAuth" takeover. The address must also sit inside the tenant's own `email_domains`.

### 4. Nothing can lock the account out

- A new or changed configuration starts in `testing`. It becomes `active` only when someone
  actually signs in through it.
- Requiring single sign-on is refused until then — in the app and by a database constraint.
- Any change to the issuer, client or domains goes back to `testing` and lifts enforcement.
- **Owners always keep the email link**, even when single sign-on is required. If the provider
  breaks, an owner can still get in and fix it.
- A sign-in link issued just before enforcement was switched on dies with it: spending a link
  re-checks enforcement.

### 5. The client secret is sealed

AES-256-GCM under `SSO_SECRET_KEY`, held only by the dashboard (Terraform key-holder map), with
the tenant id as additional authenticated data. The database alone cannot sign anyone in, and a
sealed secret copied onto another tenant's row fails to open.

### 6. Every outbound request is guarded

Discovery, the key set and the token endpoint are fetched from a URL an owner typed, from inside
our network. Each fetch passes the shared egress guard (`shared/src/egress.ts`): https only, no
private or internal addresses, no redirects, bounded size. The discovery document must name
exactly the configured issuer (OpenID Connect Discovery §4.3).

### 7. The ID token is verified, not trusted

RS256 or ES256 only — never `none`, never HMAC — with the key's type checked against the algorithm
to prevent algorithm confusion; `iss`, `aud`/`azp`, `exp`, `iat` and `nonce` all checked; `state`
bound to an HttpOnly cookie and spent on first use in Redis. `pipeline/test/sso.*` holds one test
per forgery.

## Consequences

- Staff need the link (or its code) the first time. Owners paste it into their intranet or the
  identity provider's app launcher, which is how most enterprises distribute app links anyway.
- There is no SCIM provisioning: removing someone from the provider stops their next sign-in, but
  an open dashboard session lives out its idle timeout (12 hours) or absolute lifetime (7 days).
  To cut someone off at once, an owner disables them on the Team page: every session of a
  disabled user stops resolving immediately. SCIM is the next step if a customer needs the
  provider to do that automatically.
- SAML is not supported. Every major provider speaks OpenID Connect; SAML is added only for a
  customer who cannot.
