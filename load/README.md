# Load tests (k6)

Staging only. The scripts refuse any host that is not `*.stage.naaradh.com` or localhost, and
every phone number they send is in the reserved fake range that only the simulator engine will
"dial". Staging must therefore run with `ENGINE_DEFAULT_IN=simulator` while these run.

| Script | What | Threshold (SLO) |
|---|---|---|
| `hooks-webhooks.js` | 500 Shopify `orders/create` webhooks in 60 s | p99 < 800 ms, p95 < 500 ms, failures < 1% (SPEC §6.8) |
| `voice-inbound.js` | 100 inbound-context requests in 10 s, each with a tool call | context p95 < 500 ms, tool p95 < 700 ms (ADR-0006, E-93) |
| `api-intents.js` | 50 concurrent `POST /v1/intents` → 50 simulated calls | p95 < 500 ms, every intent `scheduled` |

## Run

Install k6 (`https://grafana.com/docs/k6/latest/set-up/install-k6/`), then from the repo root:

```bash
k6 run -e HOOKS_URL=https://hooks.stage.naaradh.com -e SHOPIFY_SECRET=… -e SHOP_DOMAIN=… load/hooks-webhooks.js
k6 run -e VOICE_URL=https://voice.stage.naaradh.com -e SIMULATOR_WEBHOOK_SECRET=… -e CALLED_NUMBER=… load/voice-inbound.js
k6 run -e API_URL=https://api.stage.naaradh.com -e API_KEY=nrd_test_… load/api-intents.js
```

or `pnpm load:hooks`, `pnpm load:voice`, `pnpm load:api` with the same `-e` variables exported.
Results land in `load/results/<script>.json` (git-ignored) and the summary prints to the terminal.
GitHub Actions: `load` workflow (manual, staging environment secrets); weekly once
`LOAD_ENABLED=true`.

Variables: the Shopify secret is the **staging** app's client secret (hooks verifies the HMAC
with it); `SHOP_DOMAIN` a dev store installed on staging; `SIMULATOR_WEBHOOK_SECRET` staging's
value of that variable; `CALLED_NUMBER` a number registered in the console to a staging tenant
with inbound enabled; `API_KEY` a secret key of a staging tenant whose `lead_callback` use case
is enabled.

## Reading a failure

- `hooks` p99 over 800 ms: look at Cloud Run instance count and CPU for `hooks`, the Pub/Sub
  publish latency, and Neon query time (the route does one `resolve_tenant_by_integration` and
  one insert). Shopify retries and eventually drops subscriptions that time out.
- `voice` tool p95 over 700 ms: the engine will time out mid-call and the caller hears dead
  air. Check `voice` min instances (must be ≥ 2, CPU always on), Neon latency from the region,
  and the Redis round trips in admission.
- `api` intents not `scheduled`: outside 09:00–21:00 IST, or the tenant's use case is off, or
  the gate refused (the response says why).

The chaos side of P3-INF-4 (`workers/test/int/chaos.test.ts`) proves the worker loops
survive a Postgres and a Redis restart; the engine failure modes are in `e2e.test.ts`.
Runbook: `docs/runbooks/load-test.md`.
