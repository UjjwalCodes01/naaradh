import type { Redis } from 'ioredis';
import { paise, type Money } from '@naaradh/shared';
import { KILL_SWITCH_CACHE_TTL_SEC } from '../constants.js';
import type {
  ConcurrencyPort,
  EnginePort,
  KillSwitchPort,
  KillSwitchScope,
} from '../gate/types.js';

/**
 * Redis-backed ports: kill switches (invariant 12), concurrency (E-29), engine circuit state
 * (E-20), and the engine/global daily spend counters (E-32). Key layout is documented here
 * and nowhere else — the kill-switch runbook points at this file.
 *
 *   ks:{scope}:{key}            "1" while active                     set by staff tooling + DB row
 *   circuit:{engine}            "open" while the breaker is open     set by dispatcher/results on failure bursts, TTL
 *   conc:tenant:{tenantId}      live call count                      INCR/DECR by gate lease, TTL refreshed
 *   conc:engine:{engine}        live call count
 *   spend:engine:{engine}:{d}   paise spent today (UTC date)         INCRBY by results-consumer
 *   spend:global:{d}            paise spent today (UTC date)
 */

export const KEYS = {
  killSwitch: (scope: KillSwitchScope, key: string) => `ks:${scope}:${key}`,
  circuit: (engine: string) => `circuit:${engine}`,
  concTenant: (tenantId: string) => `conc:tenant:${tenantId}`,
  concEngine: (engine: string) => `conc:engine:${engine}`,
  spendEngine: (engine: string, utcDate: string) => `spend:engine:${engine}:${utcDate}`,
  spendGlobal: (utcDate: string) => `spend:global:${utcDate}`,
} as const;

/**
 * Invariant 12: switches are read from Redis with a ≤5 s in-process cache. Redis being down
 * is treated as "switch ON" for the global switch (fail closed) — better to hold calls for a
 * minute than to place them while nobody can stop them.
 */
export function killSwitchPort(redis: Redis, ttlSec = KILL_SWITCH_CACHE_TTL_SEC): KillSwitchPort {
  const cache = new Map<string, { value: boolean; expires: number }>();
  return {
    async isActive(scope, key) {
      const k = KEYS.killSwitch(scope, key);
      const hit = cache.get(k);
      const now = Date.now();
      if (hit !== undefined && hit.expires > now) return hit.value;
      let value: boolean;
      try {
        value = (await redis.get(k)) === '1';
      } catch {
        value = scope === 'global';
      }
      cache.set(k, { value, expires: now + ttlSec * 1000 });
      return value;
    },
  };
}

export async function setKillSwitch(
  redis: Redis,
  scope: KillSwitchScope,
  key: string,
  active: boolean,
): Promise<void> {
  const k = KEYS.killSwitch(scope, key);
  if (active) await redis.set(k, '1');
  else await redis.del(k);
}

/**
 * Concurrency slots as two counters with a rolling TTL. Acquisition is one Lua script so a
 * burst cannot over-admit between the read and the increment; release floors at zero. The
 * reconcile worker recomputes both counters from the live-attempt query every few minutes,
 * which is what repairs a leak left by a crashed dispatcher (AGENTS §5.2 step 10).
 */
const ACQUIRE_LUA = `
local t = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if t > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 'tenant'
end
local e = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
if e > tonumber(ARGV[2]) then
  redis.call('DECR', KEYS[1])
  redis.call('DECR', KEYS[2])
  return 'engine'
end
return 'ok'
`;

const RELEASE_LUA = `
for i, k in ipairs(KEYS) do
  local v = redis.call('DECR', k)
  if v < 0 then redis.call('SET', k, 0) end
end
return 1
`;

/** Longest a slot may be held without a heartbeat: max call duration + result latency. */
export const CONCURRENCY_SLOT_TTL_SEC = 15 * 60;

export function concurrencyPort(redis: Redis, ttlSec = CONCURRENCY_SLOT_TTL_SEC): ConcurrencyPort {
  return {
    async tryAcquire(tenantId, tenantMax, engine, engineMax) {
      const tenantKey = KEYS.concTenant(tenantId);
      const engineKey = KEYS.concEngine(engine);
      const result = (await redis.eval(
        ACQUIRE_LUA,
        2,
        tenantKey,
        engineKey,
        String(tenantMax),
        String(engineMax),
        String(ttlSec),
      )) as string;
      if (result === 'tenant' || result === 'engine') return { ok: false, which: result };
      let released = false;
      return {
        ok: true,
        lease: {
          tenantSlot: tenantKey,
          engineSlot: engineKey,
          release: async () => {
            if (released) return;
            released = true;
            await redis.eval(RELEASE_LUA, 2, tenantKey, engineKey);
          },
        },
      };
    },
  };
}

/** Terminal event in another process: release the slots the gate acquired for this call. */
export async function releaseConcurrency(
  redis: Redis,
  tenantId: string,
  engine: string,
): Promise<void> {
  await redis.eval(RELEASE_LUA, 2, KEYS.concTenant(tenantId), KEYS.concEngine(engine));
}

/** Reconcile job: overwrite counters with the truth from the live-attempt query. */
export async function repairConcurrency(
  redis: Redis,
  counts: { tenants: Map<string, number>; engines: Map<string, number> },
  ttlSec = CONCURRENCY_SLOT_TTL_SEC,
): Promise<void> {
  const pipeline = redis.pipeline();
  for (const [tenantId, n] of counts.tenants)
    pipeline.set(KEYS.concTenant(tenantId), String(n), 'EX', ttlSec);
  for (const [engine, n] of counts.engines)
    pipeline.set(KEYS.concEngine(engine), String(n), 'EX', ttlSec);
  await pipeline.exec();
}

export interface EngineConfig {
  readonly defaultIn: string;
  readonly defaultUs: string;
  readonly secondaryIn: string | null;
  readonly secondaryUs: string | null;
  readonly maxConcurrency: Readonly<Record<string, number>>;
  /** Regions routed to the US engine set. */
  readonly usRegions?: readonly string[];
}

const DEFAULT_US_REGIONS = [
  'US',
  'CA',
  'GB',
  'IE',
  'DE',
  'FR',
  'ES',
  'IT',
  'NL',
  'BE',
  'AT',
  'CH',
  'PT',
  'SE',
  'DK',
  'NO',
  'FI',
  'PL',
  'AU',
  'NZ',
];

export function enginePort(redis: Redis, config: EngineConfig): EnginePort {
  const usRegions = new Set(config.usRegions ?? DEFAULT_US_REGIONS);
  return {
    defaultFor: (region) =>
      region === 'IN' ? config.defaultIn : usRegions.has(region) ? config.defaultUs : null,
    secondaryFor: (region) =>
      region === 'IN' ? config.secondaryIn : usRegions.has(region) ? config.secondaryUs : null,
    async isCircuitOpen(engine) {
      try {
        return (await redis.get(KEYS.circuit(engine))) === 'open';
      } catch {
        return true; // no Redis → assume the worst; the gate will retry in a minute
      }
    },
    maxConcurrency: (engine) => config.maxConcurrency[engine] ?? 5,
  };
}

export async function openCircuit(redis: Redis, engine: string, forSec: number): Promise<void> {
  await redis.set(KEYS.circuit(engine), 'open', 'EX', forSec);
}

export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Engine/global daily spend read side (write side is the results-consumer). */
export function platformSpend(
  redis: Redis,
  caps: { engineDailyPaise: Readonly<Record<string, number>>; globalDailyPaise: number | null },
  now: () => Date,
) {
  const read = async (key: string): Promise<Money> => {
    try {
      return paise(Number((await redis.get(key)) ?? '0'));
    } catch {
      return paise(0);
    }
  };
  return {
    engineSpentToday: (engine: string) => read(KEYS.spendEngine(engine, utcDate(now()))),
    globalSpentToday: () => read(KEYS.spendGlobal(utcDate(now()))),
    engineDailyCap: (engine: string): Money | null => {
      const cap = caps.engineDailyPaise[engine];
      return cap === undefined ? null : paise(cap);
    },
    globalDailyCap: (): Money | null =>
      caps.globalDailyPaise === null ? null : paise(caps.globalDailyPaise),
  };
}

export async function recordSpend(
  redis: Redis,
  engine: string,
  amountPaise: number,
  at: Date,
): Promise<void> {
  const d = utcDate(at);
  const pipeline = redis.pipeline();
  pipeline.incrby(KEYS.spendEngine(engine, d), amountPaise);
  pipeline.expire(KEYS.spendEngine(engine, d), 3 * 86_400);
  pipeline.incrby(KEYS.spendGlobal(d), amountPaise);
  pipeline.expire(KEYS.spendGlobal(d), 3 * 86_400);
  await pipeline.exec();
}
