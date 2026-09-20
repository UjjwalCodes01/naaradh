# api

The public REST API merchants and their systems call — `api.naaradh.com`. Fastify + zod.

**What lives here:** one file per group of endpoints in `src/routes/` (intents, consents,
suppressions, knowledge, tickets, calls, billing, inbound profiles, transfer targets, webhooks),
API-key authentication and scopes (`src/auth.ts`), rate limits, and the OpenAPI document
(`src/openapi.ts` → `docs/api/openapi.json`, regenerate with `pnpm --filter @naaradh/api openapi`).

**What does NOT live here:** business rules. A route validates the request, checks the caller's
scope, and calls `pipeline/`. Whether a call may be placed is decided in `compliance/`, and only
`workers/` ever dials.

Every `/v1` route must appear in `src/openapi.ts` — a test fails otherwise.

Env: `pnpm env:list api`.
