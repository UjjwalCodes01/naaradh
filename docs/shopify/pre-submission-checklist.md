# App Store pre-submission checklist (P3-SHOP-2)

SPEC §8.6, run on a **fresh development store** with the **production** app configuration
(`shopify.app.toml`) before every submission. Tick with a date and the store's name; keep the
completed copy with the submission. Items marked `[VERIFY]` follow Shopify's current
requirements page, which changes — read it the same day.

## Before you start

- [ ] Level 2 protected customer data approved (`pcd-justification.md`); until then the app installs but every COD order is refused `no_phone` and the review would fail on function
- [ ] Legal pages final (not "pending counsel"): `/privacy`, `/terms`, `/dpa`, `/aup`, `/refunds`; versions recorded in `apps/web/src/content/legal.ts`
- [ ] Production app has **Public distribution** selected (irreversible — Partner Dashboard → App distribution)
- [ ] Production environment applied and deployed: `shopify`, `hooks`, `web`, workers all green; `SHOPIFY_BILLING_TEST=false`; `SHOPIFY_WRITEBACK=live`
- [ ] Support mailbox `support@naaradh.com` answered; `https://naaradh.com/contact` live

## Install and onboarding (10 minutes, no engineer)

- [ ] Fresh store → install link → OAuth completes → app opens embedded (App Bridge, session token; no full-page redirect loops)
- [ ] Tenant provisioned `pending_review`, owner user from the store's email, Shopify session stored sealed (`shopify_sessions.secret_kid` = current)
- [ ] Setup page: business details, GSTIN/PAN validated, spend cap, auto-cancel OFF by default, compliance declaration (clickwrap, version stamped in `audit_log`)
- [ ] Call scripts: draft scripts present; approving one re-validates the disclosure; a script without the disclosure cannot be approved
- [ ] Plan & billing: subscription approval in Shopify admin → `billing_status = active`; declining leaves `pending`
- [ ] Support line (optional): profile, fallback number, transfer target by attestation
- [ ] Go live refused until declaration + approved COD script + active plan; then allowed
- [ ] Every page also works on **Shopify mobile admin** (iOS/Android) `[VERIFY the review still tests this]`
- [ ] Every page loads in < 3 s from India and the US (Chrome devtools, no cache)

## Calling (with the real engine on production numbers, fake-range customers only)

- [ ] COD order → intent within seconds → scheduled; prepaid order → no intent; order outside 09:00–21:00 IST → gated `window`
- [ ] Order cancelled while the call is queued/ringing → attempt cancelled or outcome superseded, not billed (E-40)
- [ ] Duplicate `orders/create` delivery → one intent (E-52); a deleted webhook subscription is re-created by `shopify app deploy`
- [ ] Outcome write-back: tags, note, metafields on the order; `naaradh:address-review` tag for an address change, never a written address (Q-19)
- [ ] Usage beyond the allowance → usage record on the subscription; reaching the capped amount → outbound paused (E-61); raising the cap → resumes
- [ ] Uninstall → dispatch stops within 60 s, session deleted, tenant paused; reinstall lifts the uninstall pause only (E-48)
- [ ] `shop/redact` (48 h after uninstall on a real store; trigger by hand on the dev store) → store data purged, consent/suppression/billing kept

## Compliance webhooks and security

- [ ] `customers/data_request`, `customers/redact`, `shop/redact` subscribed on the production app; each answers 200 on a valid HMAC and **401 on an invalid one** (Shopify's automated check)
- [ ] `X-Shopify-Hmac-Sha256` verified over the raw body for every topic; unknown shop → 200 ignored
- [ ] App URL and redirect URLs on HTTPS with a valid certificate; no mixed content; `frame-ancestors` allows Shopify admin only
- [ ] Session tokens (not cookies) for embedded requests; no third-party cookies required
- [ ] No API scope beyond `read_orders, write_orders, read_customers, read_checkouts, read_fulfillments, read_locales`; each justified in `packages/shopify-sdk/src/scopes.ts` and the listing

## Listing (P3-SHOP-1)

- [ ] Name "Naaradh", tagline, description without unsupported claims (no "guaranteed RTO reduction", no percentages without a source)
- [ ] Screenshots of the real app (onboarding, order calls page, support calls page, billing) — no mock-ups
- [ ] Demo video ≤ 3 minutes showing install → first call outcome
- [ ] Pricing text matches the Billing API plans **exactly** (platform fee, included outcomes/minutes, per-outcome and per-minute rates, capped amount); usage billing explained
- [ ] Privacy policy URL, support email, support URL, developer website; categories; languages
- [ ] Listing regions: India only until Q-20 is decided (stores elsewhere see the waitlist)
- [ ] Test instructions for the reviewer: a dev store, a test customer in the fake range, what to click, what they will see; note that calls need Level 2 and that the reviewer's store will be waitlisted outside India

## Submit

- [ ] Submission date, reviewer feedback and each fix recorded below; budget 1–4 weeks and two rounds (P3-SHOP-3)

| Date | Round | Feedback | Fix / PR |
|---|---|---|---|
| | | | |
