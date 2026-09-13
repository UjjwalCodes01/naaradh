# Staff console — console.naaradh.com

**What it is (ADR-0009):** the internal tool for decisions only Naaradh staff make. Behind
Identity-Aware Proxy (Google Workspace, 2-step verification) and a staff allow-list
(`CONSOLE_ALLOWED_DOMAIN`, `CONSOLE_STAFF_EMAILS`). It holds the service role, so every action is
audited as `staff:<you>` and visible to the merchant in their access log.

## Access

- Ask an admin to add you to the IAP-secured backend (`roles/iap.httpsResourceAccessor` on the
  console backend service) — a Terraform change, reviewed.
- Locally: `CONSOLE_DEV_STAFF_EMAIL=you@naaradh.com pnpm --filter @naaradh/console dev` against
  the local database only. The console refuses that variable in production.

## What to do where

| Situation | Page | Runbook |
|---|---|---|
| A tenant was auto-paused on complaints | Complaints → mark each valid/invalid; Tenants → Resume with a written reason | complaint-received.md |
| A merchant disputes a charge | Disputes → evidence (transcript read is audited) → accept/reject | billing-dispute.md |
| A person emails dnc@ | Erasure & DNC → "Block for every business" | complaint-received.md |
| A person asks privacy@ to delete their data (identity verified) | Erasure & DNC → "Erase across every tenant" | erasure-request.md |
| Abuse, AUP breach | Tenants → Suspend (reason shown to the merchant as a suspended banner) | kill-switch.md |
| Engine incident, runaway calling | Kill switches → global / engine / tenant / inbound | kill-switch.md, engine-outage.md |

## Rules

- Resume only after reading the complaints. Marking complaints invalid does not resume a tenant.
- Every form needs a reason of at least 10 characters; write it for the next person, not for you.
- Never paste a phone number into a reason or note. Numbers go only in the phone field, which is
  hashed on arrival.
- A kill switch flip is recorded in the database first, then Redis. If the page says Redis did not
  update, flip it again; the dispatcher reads Redis.
