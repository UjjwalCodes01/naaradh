import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Db } from '@naaradh/db';
import { NaaradhError, hashApiKey, parseApiKeyEnv } from '@naaradh/shared';

/**
 * API key authentication (AGENTS §8, E-70). The key is never stored: its SHA-256 is looked
 * up through the SECURITY DEFINER function `resolve_tenant_by_api_key`, which is the one
 * pre-tenant-context read the request path needs. From here on every handler runs inside
 * withTenant(request.auth.tenantId).
 *
 *   nrd_live_ / nrd_test_   secret keys, scoped, per-key daily cap, optional IP allow-list
 *   nrd_pk_                 public site keys: intents:create only, Origin allow-list,
 *                           tighter per-IP rate limit (the JS snippet, SPEC §9.2)
 */
export interface AuthContext {
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly kind: 'secret' | 'public';
  readonly scopes: ReadonlySet<string>;
  readonly dailyCap: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

type ResolvedKey = {
  tenant_id: string;
  api_key_id: string;
  kind: 'secret' | 'public';
  scopes: string[];
  allowed_domains: string[] | null;
  ip_allowlist: string[] | null;
  daily_cap: number | null;
  tenant_status: string;
  revoked_at: Date | null;
};

export interface AuthDeps {
  readonly db: Db;
  readonly redis: Redis;
  readonly defaultDailyCap: number;
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  app.decorateRequest('auth', undefined);

  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.config.public === true) return;
    const header = request.headers.authorization;
    const key = header?.startsWith('Bearer ') === true ? header.slice(7).trim() : undefined;
    if (key === undefined || parseApiKeyEnv(key) === null)
      throw new NaaradhError('UNAUTHENTICATED', 'missing or malformed API key', {
        context: { hint: 'Authorization: Bearer nrd_live_…' },
      });

    const [row] = (
      await deps.db.execute<ResolvedKey>(
        sql`select * from resolve_tenant_by_api_key(${hashApiKey(key)})`,
      )
    ).rows;
    if (row === undefined) throw new NaaradhError('UNAUTHENTICATED', 'unknown API key');
    if (row.revoked_at !== null) throw new NaaradhError('UNAUTHENTICATED', 'API key revoked');
    if (row.tenant_status === 'suspended' || row.tenant_status === 'uninstalled')
      throw new NaaradhError('FORBIDDEN', 'account is not active', {
        context: { status: row.tenant_status },
      });

    // E-70: optional IP allow-list on secret keys.
    if (
      row.ip_allowlist !== null &&
      row.ip_allowlist.length > 0 &&
      !row.ip_allowlist.includes(request.ip)
    ) {
      throw new NaaradhError('FORBIDDEN', 'request IP not in the key allow-list');
    }
    // Public keys are used from browsers: the Origin must be on the key's domain list.
    if (row.kind === 'public') {
      const origin = request.headers.origin ?? '';
      const host = safeHost(origin);
      const allowed = (row.allowed_domains ?? []).some((d) => host === d || host.endsWith(`.${d}`));
      if (!allowed) throw new NaaradhError('FORBIDDEN', 'origin not allowed for this public key');
    }

    request.auth = {
      tenantId: row.tenant_id,
      apiKeyId: row.api_key_id,
      kind: row.kind,
      scopes: new Set(row.scopes),
      dailyCap: row.daily_cap ?? deps.defaultDailyCap,
    };

    // last_used_at, at most once a minute per key, without holding the request.
    void deps.redis.set(`key_touch:${row.api_key_id}`, '1', 'EX', 60, 'NX').then(async (set) => {
      if (set === 'OK')
        await deps.db
          .execute(sql`select touch_api_key(${row.api_key_id}, now())`)
          .catch(() => undefined);
    });
  });
}

function safeHost(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}

export function requireScope(request: FastifyRequest, scope: string): AuthContext {
  const auth = request.auth;
  if (auth === undefined) throw new NaaradhError('UNAUTHENTICATED', 'unauthenticated');
  if (!auth.scopes.has(scope))
    throw new NaaradhError('FORBIDDEN', `API key lacks scope ${scope}`, { context: { scope } });
  return auth;
}

/** E-70: per-key daily cap on intent creation, counted in Redis by UTC day. */
export async function consumeDailyCap(redis: Redis, auth: AuthContext, now: Date): Promise<void> {
  const key = `key_daily:${auth.apiKeyId}:${now.toISOString().slice(0, 10)}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 2 * 86_400);
  if (n > auth.dailyCap) {
    await redis.decr(key);
    throw new NaaradhError('RATE_LIMITED', 'daily intent cap for this API key reached', {
      context: { cap: auth.dailyCap },
      retryAfterSec: 3600,
    });
  }
}
