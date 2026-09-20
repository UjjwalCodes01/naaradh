# console — staff console

Internal tool at console.naaradh.com, **behind Identity-Aware Proxy only** (ADR-0009). Fastify
with server-rendered HTML and no client script; the IAP JWT is verified in-process and the email
checked against `CONSOLE_ALLOWED_DOMAIN` / `CONSOLE_STAFF_EMAILS`. It holds the service role
because its job is cross-tenant; every action is audited as `staff:<email>`.

Complaints (mark valid/invalid), tenants (resume after complaints, suspend), disputes (evidence
incl. transcript — audited — and the decision that writes the credit), kill switches (database
record + Redis hot copy), global erasure and do-not-call requests from the dnc@ / privacy@
mailboxes. How to use it: `docs/runbooks/staff-console.md`.

```bash
CONSOLE_DEV_STAFF_EMAIL=you@naaradh.com pnpm --filter @naaradh/console dev   # :3004, local DB only
```
