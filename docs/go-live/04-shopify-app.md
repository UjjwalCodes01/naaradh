# 4. Shopify app (Partner account, apps, dev store, Level 2, App Store)

The embedded app is built (`apps/shopify`, ADR-0007/0009): install provisioning, onboarding,
script approval, support-line setup and Shopify Billing. What it needs from Shopify is an
**account, two app records (staging and production), a development store, a protected-data
approval, and finally App Store review**. Nothing here is done by code or CI — a human does it
(CLAUDE.md: no Partner Dashboard changes by agents).

## 1. Partner account (P0-LEG-6)

1. Sign up at **partners.shopify.com** with a naaradh.com Workspace address (1 day). Turn on 2FA.
   Add a second admin.
2. Read the **Partner Program Agreement** and the App Store requirements; note the revenue share
   on app charges and the billing rules (all charges inside the app must use the Billing API —
   the app already does).
3. Payouts: add the company's bank account and tax details in the Partner account once the
   company and current account exist ([01](01-company-and-legal.md)). Shopify payouts arrive from a
   foreign entity — export of services, LUT (Q-11).

**Two dashboards, as of 2026:** apps are created and configured in the **Dev Dashboard**
(`dev.shopify.com/dashboard`) or by the Shopify CLI; **distribution, App Store listing and
payouts** live in the **Partner Dashboard**. Distribution is chosen separately from creating the
app, and **cannot be changed once selected** — choose *Public* for the production app only when
you are ready to list it.

## 2. Create the two apps with the CLI

Use two separate app records so staging never touches production merchants (SPEC §8.7):

| App | Config file | App URL | Webhooks to |
|---|---|---|---|
| Naaradh (staging) | `apps/shopify/shopify.app.staging.toml` | `https://shopify.stage.naaradh.com` | `https://hooks.stage.naaradh.com/shopify/webhooks` |
| Naaradh (production) | `apps/shopify/shopify.app.toml` (committed) | `https://shopify.naaradh.com` | `https://hooks.naaradh.com/shopify/webhooks` |

From `apps/shopify` (Shopify CLI 3.x is installed; upgrade with `npm i -g @shopify/cli@latest`):

```bash
shopify app config link          # choose your organisation → "create a new app" → name it
                                 # writes client_id into the toml it links
shopify app config use staging   # switch between linked configs
shopify app deploy               # releases a version: scopes, URLs, webhook subscriptions
```

For the staging config, copy `shopify.app.toml` to `shopify.app.staging.toml` and change the
`application_url`, `[auth] redirect_urls` and both webhook `uri` values to the stage hostnames.
Keep `api_version = "2026-07"` equal to `SHOPIFY_ADMIN_API_VERSION` in the workers.

What the toml declares (don't change without the process in CLAUDE.md):

- **Scopes:** `read_orders, write_orders, read_customers, read_checkouts, read_fulfillments,
  read_locales` — reasons per scope in `packages/shopify-sdk/src/scopes.ts`. `write_customers` is
  deliberately **not** requested (Q-07).
- **Webhooks:** 13 topics plus the three mandatory privacy topics (`customers/data_request`,
  `customers/redact`, `shop/redact`), all delivered to **hooks**, which verifies the HMAC and
  answers 401 on a bad one.
- **Embedded** app; auth redirect URLs on the app host.
- **Extensions** (`apps/shopify/extensions/`, ADR-0010 §2): `call-consent-checkout` (checkout UI
  extension, Shopify Plus stores) and `call-consent-cart` (theme app block for the cart page, every
  plan). Both show the consent wording and write the `naaradh_call_consent` attribute. They are
  released by the same `shopify app deploy`; the CLI builds them from their own `package.json`
  (not the pnpm workspace). Check the target and API version against the Shopify changelog first
  (`[VERIFY]` in the toml), and do not deploy them to production until counsel approves the
  wording (Q-08) — the text lives in `packages/pipeline/src/promotional/consent-wording.ts` and
  a unit test fails if the extension copies drift from it. Merchants add the cart block in the
  theme editor (Customize → Cart → Add block → *Call consent (Naaradh)*); Plus merchants add the
  checkout extension in the checkout editor.

### Credentials → configuration

From the app's settings in the Dev Dashboard copy the **Client ID** and **Client secret** (per app,
per environment):

| Value | Secret name | Held by |
|---|---|---|
| Client ID | `SHOPIFY_API_KEY` | shopify app; workers writebacks, actions, billing, reconcile |
| Client secret | `SHOPIFY_API_SECRET` | hooks (webhook HMAC), shopify app, the same four workers (token refresh) |
| 32 random bytes | `SHOPIFY_TOKEN_KEY` | shopify app + the same four workers — seals stored tokens ([07](07-secrets-and-configuration.md)) |

Add the values to Secret Manager for the matching environment, enable the `shopify` service in
the env's tfvars with its hostname, and apply ([05](05-cloud-infrastructure.md)). Offline tokens
expire hourly for new public apps; the app refreshes them, and the workers refresh the same stored
session (`apps/workers/src/shopify-tokens.ts`).

## 3. Development store

1. In the Dev Dashboard (or Partner Dashboard → Stores), create a **development store**; country
   India, currency INR.
2. Payments → **Manual payment methods → Cash on Delivery (COD)**; also enable Shopify's
   **Bogus Gateway** for prepaid test orders (SPEC §8.7).
3. Add a few products, a test customer with a phone number in the **fake range**
   (`+91 60000 00xxx`) — never a real person's number.
4. Install the staging app from its install link (or `shopify app dev` against the store while
   developing). The app provisions the store as a tenant in `pending_review` with default use
   cases OFF and draft scripts.

Billing on a development store uses **test charges** — the app sets `test: true` whenever
`SHOPIFY_BILLING_TEST` is true (default outside production).

## 4. Local development against the dev store

```bash
pnpm dev:shopify     # shopify app dev — tunnel + dev store; needs SHOPIFY_* and DATABASE_URL etc.
```

Webhooks from `shopify app dev` go to the hooks URL in the toml, so for local work run hooks and
workers too (README "Running the pipeline locally"), or trigger a topic on demand:

```bash
shopify app webhook trigger --topic orders/create --address https://<your tunnel>/shopify/webhooks
# see `shopify app webhook trigger --help` for the API-version and client-secret flags it asks for
```

## 5. Onboarding flow the merchant sees

Home → **Setup** (business details, GSTIN/PAN, DLT PE ID, spend cap, auto-cancel, compliance
declaration) → **Call scripts** (approve) → **Plan & billing** (approve in Shopify admin) →
**Support line** (optional) → **Go live**. Go-live is refused until the declaration is accepted,
a COD script is approved and a plan is active. Stores outside India see a waitlist screen (Q-20).

## 6. Dev-store test matrix

P2-SHOP-8. Run on the staging app with the simulator engine first, then with the real engine:

- [ ] Fresh install → tenant provisioned, owner user created from the shop email, sessions stored sealed
- [ ] Onboarding end to end; go-live refused until the three conditions hold
- [ ] COD order → intent within seconds; prepaid order → no call; order outside 09:00–21:00 IST → not called
- [ ] Order cancelled by the merchant while the call is queued/ringing → cancelled / superseded, not billed (E-40)
- [ ] Duplicate `orders/create` delivery → one intent (E-52); missed webhook → picked up by the hourly reconcile (E-53)
- [ ] Outcome write-back: tags, note, metafields on the order (`SHOPIFY_WRITEBACK=live` on staging only for this test)
- [ ] Billing: approve → plan active; decline → stays pending; usage beyond the allowance → usage records; cap reached → outbound paused (E-61); raise cap → resumes
- [ ] Uninstall → dispatch stops within 60 s, session deleted; reinstall → uninstall pause lifted, complaint pause kept (E-48)
- [ ] `shop/redact` 48 h later → store data purged, legal records kept
- [ ] Bad HMAC on a compliance webhook → 401 (Shopify's automated check also tests this)
- [ ] Embedded app on Shopify mobile admin loads and works

## 7. Protected customer data (Level 2)

The app reads customer **phone and name**, so it needs **Level 2** approval before listing; until
then Shopify returns `null` for those fields and the gate refuses with `no_phone` (SPEC §8.2).

1. Partner/Dev Dashboard → the production app → **API access → Protected customer data**
   `[VERIFY the current menu path]`.
2. Select the fields (phone, name; shipping address only for the pincode) and the purpose, and
   answer the data-protection questions — the answers and evidence are written up in
   **`docs/shopify/pcd-justification.md`**.
3. Before submitting: counsel-approved privacy policy and DPA, an incident response plan, and the
   sub-processor list naming the chosen engine and telephony provider. Q-16 (database region)
   answered or disclosed.

Lead time is uncertain (Q-10) — treat it as the critical path and submit as soon as the legal
pages are final.

## 8. App Store listing and review

Checklist (SPEC §8.6, `[VERIFY current list]`):

- [ ] Choose **Public distribution** for the production app (Partner Dashboard → App distribution;
      irreversible)
- [ ] Listing: name, tagline, description, screenshots, a demo video, pricing that matches the
      Billing API plans exactly, FAQ
- [ ] Privacy policy URL (`https://naaradh.com/privacy`), support email (support@naaradh.com),
      support URL (`https://naaradh.com/contact`)
- [ ] Embedded, App Bridge, session tokens, Polaris; works on mobile admin; loads in < 3 s
- [ ] Clean install on a fresh dev store, no broken links, uninstall cleans up
- [ ] Mandatory compliance webhooks HMAC-verified
- [ ] Level 2 approved
- [ ] Budget 1–4 weeks and two review rounds

## 9. Moving Client A from the custom app to the public app

Client A runs today as a **custom-app mirror** (webhooks verified with a per-shop secret in
`SHOPIFY_WEBHOOK_SECRETS`). To move them:

1. Install the **production** public app on Client A's store. Provisioning finds the existing
   Shopify integration for that shop and switches it to the new stored session
   (`shopify-session:offline_<shop>`); the tenant, its history and settings stay.
2. Confirm webhooks arrive from the public app (hooks logs; `webhook_events`).
3. Uninstall the old custom app from the store and remove its entry from `SHOPIFY_WEBHOOK_SECRETS`.
4. Re-approve a plan through Shopify Billing if Client A was on a manual arrangement.
