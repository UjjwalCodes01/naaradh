# web — merchant dashboard and public site

Next.js 15 App Router. One deployment serves the public pages (naaradh.com: home, pricing,
legal drafts, `/do-not-call`) and the signed-in dashboard under `/app` (app.naaradh.com).

**Rules this app lives by (ADR-0009)**

- The database role is `naaradh_app` only; every tenant read and write runs in `withTenant()`
  through `@naaradh/pipeline`. Sign-in and session lookup use the SECURITY DEFINER functions of
  migration 0009. Production refuses `DATABASE_SERVICE_URL` and every private key.
- Magic-link sign-in; the link opens a page with a button (POST), so scanners cannot spend it.
- Numbers are always masked. Recordings and transcripts need the operator role and are audited
  before they are served (15-minute signed GCS URLs; `<audio preload="none">`).
- Server components render; server actions change things (Next checks the Origin on every
  action). The only client component is `<ActionForm>`. A per-request CSP nonce allows no
  third-party script, frame or connection.

| Path | For |
|---|---|
| `/app` | Last 7 days, this month's usage, why orders were not called |
| `/app/orders`, `/app/orders/:id` | Order calls: gate verdict in plain language, attempts, disclosures, outcome, write-back, dispute |
| `/app/support-calls` | Inbound calls: verification level, every tool the agent used, tickets |
| `/app/tickets`, `/app/knowledge` | Work tickets; write the knowledge base |
| `/app/agent`, `/app/scripts` | Support-agent profiles and transfer numbers; approve outbound scripts |
| `/app/privacy` | Blocked numbers, complaints, deletion requests |
| `/app/billing`, `/app/settings`, `/app/team`, `/app/developers`, `/app/activity` | Plan and disputes; account settings; people and roles; API keys and webhook health; access log |

```bash
pnpm --filter @naaradh/web dev      # :3000, reads ../.env.local; sign-in links are logged in dev
pnpm --filter @naaradh/web build    # output: standalone (web/Dockerfile)
```
