# Merchant access — sign-in problems, removing a person, email not arriving

**How it works (ADR-0009):** merchants sign in to app.naaradh.com with a single-use email link
(15 minutes). Sessions last 7 days at most and end after 12 idle hours. Inside Shopify admin the
embedded app needs no separate sign-in. Roles: viewer < operator < manager < owner.

## "I never got the sign-in email"

1. The page answers the same whether or not the address has an account. Check the address is on
   the account: console → Tenants → the store → People.
2. Postmark → Activity → search the address (tag `login`). Bounced or suppressed addresses need a
   fix at Postmark; a delivered one is in the merchant's spam folder.
3. Rate limits: 5 requests per address per hour, 20 per network per hour. Wait, or check Redis
   `rl:web:login-email:*`.
4. A person with no account yet: an owner or manager adds them (Team → Invite); for a brand-new
   direct merchant, staff create the owner user (seed script pattern) — Shopify stores get their
   owner automatically from the shop's email at install.

## "The link says expired"

Links work once and for 15 minutes. Mail scanners fetch links but cannot spend them (the link
opens a page with a Sign in button). Request a new link.

## Remove someone now (left the company, lost a laptop)

Team → Remove. That disables the user and ends every session at once. Nobody can remove the last
owner; make someone else owner first. Audit: `user.disabled`, `user.signed_out`.

## Suspected account takeover

1. Team → Remove the person (or "Sign out everywhere" for yourself).
2. Access log → "Show every change" for what the session did (recording plays, settings changes,
   API keys created). Revoke any key it created (Developers).
3. Tell security@naaradh.com; staff can pause the tenant from the console while you look.

## Merchant emails (alerts, daily summary)

Queued in `merchant_notifications`, sent by `WORKER=notifications` to owners and managers.
Alerts (complaint, pause, capped/frozen billing, erasure done) always send; the daily summary and
the "not called" digest follow Settings → Email.

```sql
select kind, status, attempts, last_error, sent_at from merchant_notifications
where tenant_id = '<ten_…>' order by created_at desc limit 20;
```

`dead` after 8 attempts means Postmark refused or was down for hours: fix, then
`update merchant_notifications set status='failed', attempts=0, next_attempt_at=now() where id=…`.
