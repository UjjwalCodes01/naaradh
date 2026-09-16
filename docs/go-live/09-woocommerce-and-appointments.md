# 9. WooCommerce and the appointments vertical

**Audience:** the founder. **Code state:** built and tested (`docs/phase-reviews/phase-5.md`,
ADR-0011). Everything below is the part only a person can do: a WordPress.org listing, a Cal.com
account, and one credential per merchant.

Nothing here is needed for Shopify merchants or for the support line. Do it when a WooCommerce
merchant or an appointment-vertical merchant is actually in front of you.

---

## 1. WooCommerce plugin

The plugin lives in `plugins/woocommerce` (GPL-2.0-or-later, as WordPress requires). It reports
orders and carts to `api.naaradh.com` from the merchant's server and writes results back as order
notes. It never cancels or edits an order.

### Give a merchant the plugin today (no listing needed)

1. Zip the folder: `cd plugins && zip -r naaradh-woocommerce.zip woocommerce -x '*/node_modules/*'`.
   (Rename the inner folder to `naaradh` first if you want the plugin slug to read that way.)
2. They upload it in **Plugins → Add New → Upload**.
3. In Naaradh: create the merchant (console → Tenants → New merchant), then an API key with
   scopes `intents:create`, `orders:write`, `carts:write` (dashboard → Developers).
4. In WooCommerce → Settings → **Naaradh**: paste the key; switch on the calls they want; paste
   the consent wording **version** and its exact text from the dashboard; then register a webhook
   in Naaradh pointing at `https://<their-store>/wp-json/naaradh/v1/events` and paste its signing
   secret back into the settings.
5. Watch the top of that settings page — it names anything still missing (no key, consent wording
   not set, phone field hidden at checkout, last API error).

### Listing it on WordPress.org (P5-WOO-2)

WordPress.org hosts plugins in **Subversion**, and review is by a volunteer team; expect days to
weeks, and one round of notes.

- [ ] Read the plugin guidelines once: <https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/>
- [ ] Submit at <https://wordpress.org/plugins/developers/add/> with the zip. The reviewers check,
      in this order: GPL-compatible licence (declared in the header — it is), **no obfuscated
      code** (there is none), **disclosure of every external service** the plugin calls (the
      "Description" section of `readme.txt` names `api.naaradh.com` and what is sent, with links
      to the terms, privacy policy and DPA — keep that accurate), no tracking without consent,
      sanitised input and escaped output, and no trademark misuse in the slug.
- [ ] Reply to their notes from the same email; do not re-submit a second copy.
- [ ] On approval: `svn co https://plugins.svn.wordpress.org/<slug>`, copy the files into
      `trunk/`, `svn cp trunk tags/0.1.0`, `svn ci`. The readme's `Stable tag` decides what users
      get — bump it with each release.
- [ ] Assets (icon, banner, screenshots) go in `assets/`, not `trunk/`.

`[VERIFY]` the URLs above before submitting; WordPress.org moves things occasionally.

### Test matrix before a merchant goes live (P5-WOO-3)

There is no PHP runner in this repository's CI, so this matrix is manual. Use a throwaway site
(LocalWP or a staging clone) and phone numbers from the reserved test range only.

| Case | Expect |
|---|---|
| WordPress 6.4 and 6.7, PHP 8.1 and 8.3 | Plugin activates, no notices |
| Classic checkout, COD order with a phone | Order note "confirmation call queued"; an intent in Naaradh |
| Block checkout (WooCommerce 8.9+) | Consent checkbox appears; ticking it stores the wording version on the order |
| Consent box left unticked | No promotional consent recorded; a cart is not called |
| Prepaid order | No confirmation call; the order still reaches the support-line cache |
| Phone field hidden at checkout | Settings page warns; nothing sent |
| HPOS (custom order tables) on and off | Both work (the plugin uses the CRUD API only) |
| API key revoked | Admin notice appears; orders still complete |
| Webhook secret wrong | Store logs a 401 "bad signature"; no order note |
| Cart abandoned, then the order placed | The queued recovery call is cancelled |
| Guest checkout, then uninstall | Options removed; order notes kept |

---

## 2. Appointments (Cal.com or a manual diary)

### Choose per merchant

- **`manual`** — no provider. Naaradh offers a fixed grid from the slot length you set. Good for a
  pilot; the merchant reads bookings in their Naaradh dashboard and their own diary stays theirs.
- **`calcom`** — Cal.com holds the availability and the bookings. Needs an account and an API key.
- **Google Calendar** — not built (needs per-merchant OAuth, ADR-0011 §5). Do not promise it.

### Cal.com setup (per merchant)

1. The merchant (or you, on their team) creates the Cal.com account and an **event type** for the
   service — its length is the slot length Naaradh will offer.
2. Create an API key in Cal.com (Settings → Developer → API keys).
3. Put the key in Secret Manager — Naaradh stores only the reference:

```bash
printf '%s' 'cal_live_…' | gcloud secrets create "calcom-$TENANT_ID" \
  --data-file=- --replication-policy=user-managed --locations=asia-south1 --project="$GCP_PROJECT"
# the reference to paste into the console:
echo "sm://projects/$GCP_PROJECT/secrets/calcom-$TENANT_ID"
```

4. Console → the tenant → **Calendars** → Connect:
   - provider `calcom`, the **event type id** from Cal.com, the name the agent should say
     ("Blood test"), the merchant's time zone, the slot length;
   - the `sm://…` reference (never the key itself — the console refuses anything that looks like
     a raw key);
   - config: `{"eventTypeId": 123456, "attendeeEmail": "appointments@merchant.example"}`. Cal.com
     requires an attendee email on every booking and Naaradh asks customers for none, so
     bookings are made under that mailbox. Agree it with the merchant (Q-26).
5. **`[VERIFY]` before the first real booking:** the adapter's request and response shapes are
   written from Cal.com's published v2 API and have never run against a live account (Q-25).
   Book one slot on a test event type, compare the response with
   `packages/calendar/src/calcom.ts`, and correct the parsers if they differ. A changed shape
   fails loudly — the agent offers a callback instead of a made-up time — so the failure mode is
   safe, but it is still a failure.

### Then, for the merchant

- Switch on **appointment confirmation** (dashboard → Settings) and approve its script in the
  customer's language. It is a *service* purpose: no consent row and no DLT template needed.
- Appointments reach Naaradh either from the merchant's system (`PUT /v1/appointments/{ref}`) or
  because the agent booked them on a call.
- **The merchant must send `consent` with each appointment** — how the customer asked for it
  (`form`, `api`, `verbal`, with their own evidence reference). A reminder is a service call and
  India wants that record; without it every reminder is refused `consent:missing`. Appointments
  the agent books on a call carry `verbal` consent automatically, with the call as evidence.
- One reminder call per appointment, 24 to 2 hours before, inside 09:00–21:00 where the customer
  is. The merchant sees the diary and each decision under **Appointments**.

### Healthcare merchants

The shipped appointment scripts refuse diagnosis, prescriptions and test results, and send
anything clinical to a ticket or a transfer. Do not agree to a script that answers clinical
questions — that is an AUP matter, not a script change. A lab or clinic also needs its own
consent and record-keeping obligations checked by counsel before it goes live. `[LEGAL]`

---

## 3. One-click checkouts (GoKwik, Shiprocket, Razorpay Magic, Cashfree)

Still blocked on partner access (Q-09), and deliberately not guessed at: those stores send no
abandoned-checkout webhook Naaradh can read. Two ways forward, in order of preference:

1. **Partner/API access** from the provider → then a small ingestion adapter is written for their
   payloads, reusing the same cart path.
2. **Today, with no partner deal:** the merchant's own glue (a script, a Zap, their developer)
   posts the cart to `PUT /v1/carts/{ref}` with the consent wording version, and
   `POST /v1/carts/{ref}/completed` when the order lands. Everything after that — the 45-minute
   wait, consent, DND, the one-call-a-week rule — is Naaradh's, unchanged.

Until one of those exists, those stores get COD confirmation, feedback and the support line, and
their Results page honestly shows zero checkouts (E-111).
