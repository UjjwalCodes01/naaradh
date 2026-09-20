# 6. Email and payments

## 1. Google Workspace

P0-INF-3. Workspace on naaradh.com gives the team mail and the Google Cloud organisation.

**Mailboxes or groups the product and legal pages already point to:**

| Address | Used for |
|---|---|
| `support@` | Merchant support; App Store support email |
| `sales@` | Enterprise enquiries (pricing page) |
| `billing@` | Razorpay subscription problems (dashboard message) |
| `privacy@` | DPDP grievances and data requests (`/grievance`, `/privacy`) |
| `dnc@` | Do-not-call requests by email (`/do-not-call`) — staff act on them in the console |
| `security@` | Vulnerability reports (`/security`); also publish `/.well-known/security.txt` |
| `legal@` | Legal notices |
| `staff@` (group) | People allowed into the staff console via IAP |

DNS for mail (SPEC §7.1): MX to Google; SPF `v=spf1 include:_spf.google.com include:<postmark> -all`;
DKIM for Workspace and Postmark; DMARC `v=DMARC1; p=quarantine; rua=mailto:dmarc@naaradh.com`.
Enforce **2-step verification** for every account (it also protects the staff console).

## 2. Postmark (transactional email)

The dashboard sends sign-in links and invites; the `notifications` worker sends alerts (complaint,
pause, spending cap, payment problem, erasure done) and the daily summary. No email ever contains
customer data. Code: `notify` (Postmark over HTTPS, open/link tracking **off**).

1. Create a Postmark account; create one **Server** per environment (staging, production).
2. Add the sending domain **mail.naaradh.com** and publish the DKIM TXT record and the
   Return-Path CNAME Postmark shows; wait until both verify.
3. Use the default transactional **message stream** (`outbound`).
4. New Postmark accounts can only send to their own domain until the account is approved
   `[VERIFY]` — request approval before inviting merchants.
5. Copy each server's **API token** → secret `POSTMARK_TOKEN` (held by `web` and
   `workers-notifications`). Sender: `MAIL_FROM` defaults to `Naaradh <no-reply@mail.naaradh.com>`.

In production, the dashboard and the notifications worker **refuse to start** without a Postmark
token — sign-in and alerts would silently fail otherwise. Locally, without a token, emails go to an
in-memory outbox and the dashboard logs sign-in links.

## 3. Razorpay

Shopify stores pay through Shopify; every other Indian merchant subscribes through **Razorpay
Subscriptions** (P2-BILL-3, ADR-0008). Usage beyond a plan's allowance is added to the next invoice
as an add-on, net of dispute credits.

1. **Account and KYC** with the company: PAN, GSTIN, CoI, current account (3–7 days).
   Add the GSTIN so Razorpay issues GST invoices. Enable **Subscriptions**.
2. **Create plans** (monthly) for each combination you offer, with the platform fee from the plan
   catalogue (`pipeline/src/billing/plans.ts`; public pricing page). How GST is added to
   the plan amount — confirm with the CA.
3. Map them in the secret-free env var **`RAZORPAY_PLAN_IDS`** (JSON). Key format:
   `<outbound plan or ->+<support-line plan or ->`:

   ```json
   { "growth+-": "plan_…", "-+inbound_growth": "plan_…", "growth+inbound_growth": "plan_…" }
   ```

   A combination missing from the map is refused ("this plan combination is not offered").
   Plan ids are not secret: set the JSON for `api` and `web` through `service_env` in the
   environment's tfvars.
4. **API keys** (Key ID + Key Secret) → secrets `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (held by
   `api`, `web`, `workers-billing`). Use **test-mode** keys on staging.
5. **Webhook:** URL `https://hooks.naaradh.com/razorpay/webhooks`, events
   `subscription.authenticated, activated, charged, completed, updated, pending, halted, cancelled,
   paused, resumed`; its secret → `RAZORPAY_WEBHOOK_SECRET` (hooks only). Without it the route
   answers 404. Webhooks are treated as hints: the billing worker re-fetches the subscription
   before changing anything.
6. List the Razorpay secrets in the environment's `enabled_optional_secrets` and apply.

Operations: `docs/runbooks/billing-postings.md` (charges, capped/frozen), `billing-dispute.md`.

## 4. Shopify Billing

Nothing to set up beyond the Partner account payouts ([04](04-shopify-app.md#1-partner-account-p0-leg-6)):
the app creates the subscription (recurring fee + capped usage line) and the billing worker posts
usage records. Test charges on development stores.

## 5. Later

- **Stripe** for USD/EUR/GBP direct merchants — Phase 6 (P6-BILL-1). `STRIPE_SECRET_KEY` is
  reserved; no code uses it yet.
- A status page (`status.naaradh.com`) and developer docs host (`docs.naaradh.com`) — Phase 3/5.

## 6. Checklist

- [ ] Workspace, mailboxes/groups above, SPF/DKIM/DMARC, 2SV enforced
- [ ] Postmark servers (staging, prod), mail.naaradh.com verified, account approved, tokens in Secret Manager
- [ ] Razorpay KYC done, GSTIN added, Subscriptions on, plans created, `RAZORPAY_PLAN_IDS` set
- [ ] Razorpay keys + webhook secret in Secret Manager; webhook pointing at hooks
