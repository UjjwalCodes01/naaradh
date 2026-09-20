# Load and chaos tests

**Trigger:** weekly on staging (AGENTS.md §12), before any production deploy that touches `hooks`, `voice` or the dispatcher, and after a sizing change in `infra/envs/*.tfvars`.

**Never against production. Never with real numbers.** The scripts in `load/` refuse a host outside `*.stage.naaradh.com` and only send numbers in the reserved fake range; staging must be on the simulator engine (`ENGINE_DEFAULT_IN=simulator`) while they run.

## Run

```bash
# from the repo root, k6 installed (load/README.md)
k6 run -e HOOKS_URL=https://hooks.stage.naaradh.com -e SHOPIFY_SECRET=… -e SHOP_DOMAIN=… load/hooks-webhooks.js
k6 run -e VOICE_URL=https://voice.stage.naaradh.com -e SIMULATOR_WEBHOOK_SECRET=… -e CALLED_NUMBER=… load/voice-inbound.js
k6 run -e API_URL=https://api.stage.naaradh.com -e API_KEY=nrd_test_… load/api-intents.js   # 09:00–21:00 IST only
```

Or Actions → **load** → Run workflow (stage environment holds the values). Summaries are printed and saved as artifacts.

## Pass / fail

| Script | Threshold | Why |
|---|---|---|
| hooks | p99 < 800 ms, p95 < 500 ms, failures < 1 % over 500 webhooks / 60 s | Shopify and the engines retry slow acks and drop subscriptions that keep failing (SPEC §6.8) |
| voice | inbound context p95 < 500 ms; tool call p95 < 700 ms | Above it the engine times out mid-call; the caller hears dead air or the fallback (ADR-0006, E-93) |
| api | p95 < 500 ms; every intent `scheduled` | 50 concurrent calls must fit `ENGINE_MAX_CONCURRENCY` and the tenant's cap |

A failed threshold exits non-zero. Do not deploy to production on a red run without a written reason in the deploy's PR.

## When a threshold fails

1. **hooks slow:** Cloud Run → `hooks` → instances and CPU during the run; Pub/Sub publish latency; Neon query latency from the region (`resolve_tenant_by_integration` + one insert per webhook). Fix: raise `min_instances`/CPU in tfvars, or check for a Neon cold compute (autosuspend must be off in stage/prod).
2. **voice slow:** `voice` must have `min ≥ 2` and CPU always allocated (locals.tf); check Redis latency (admission reads kill switches and counters) and Neon. If only tool calls are slow, look at the tool handler's queries (`voice/src/tools/handlers.ts`).
3. **api intents not scheduled:** the response body says why (`gated` with a reason — outside the window, use case off, cap reached). That is the gate working, not a performance problem.
4. **5xx during the run:** the SLO alert policies fire on staging too; read the logs with `jsonPayload.level >= 50`.

## Chaos

`workers/test/int/chaos.test.ts` (runs in `pnpm test:int`) restarts Postgres and Redis under the running dispatcher and reconcile loops and proves they carry on and process work afterwards. The loops back off exponentially (1 s → 30 s) on a failed tick and log `worker loop unhealthy` after five consecutive failures — that line pages (`infra/main.tf` → `log_alerts.loop_unhealthy`). Engine failures (5xx opening the breaker, 429, timeout-uncertain) and duplicate / out-of-order / missing webhooks are covered by `e2e.test.ts`.

To run the chaos test alone: `pnpm exec vitest run --config vitest.int.config.ts workers/test/int/chaos.test.ts`.
