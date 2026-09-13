import type { Redis } from 'ioredis';
import type { Tx } from '@naaradh/db';
import type { GateDeps } from '../gate/types.js';
import {
  attemptPort,
  consentPort,
  flagPort,
  loadGateInput,
  numberPort,
  scriptPort,
  suppressionPort,
  tenantSpend,
} from './db.js';
import { dndPort } from './dnd.js';
import {
  concurrencyPort,
  enginePort,
  killSwitchPort,
  platformSpend,
  type EngineConfig,
} from './redis.js';

export * from './db.js';
export * from './redis.js';
export * from './dnd.js';

export interface GateDepsConfig {
  readonly engines: EngineConfig;
  readonly engineDailyCapPaise: Readonly<Record<string, number>>;
  readonly globalDailyCapPaise: number | null;
}

/**
 * Wire every port for one gate evaluation inside a tenant transaction. The dispatcher calls:
 *
 *   withTenant(db, tenantId, async (tx) => {
 *     const loaded = await loadGateInput(tx, intentId);
 *     const deps = buildGateDeps(tx, redis, config, loaded.tenantZone, now);
 *     return gateIntent({ ...loaded, now }, deps);
 *   })
 */
export function buildGateDeps(
  tx: Tx,
  redis: Redis,
  config: GateDepsConfig,
  tenantZone: string,
  now: Date,
): GateDeps {
  const tenant = tenantSpend(tx, tenantZone, now);
  const platform = platformSpend(
    redis,
    { engineDailyPaise: config.engineDailyCapPaise, globalDailyPaise: config.globalDailyCapPaise },
    () => now,
  );
  return {
    engines: enginePort(redis, config.engines),
    killSwitches: killSwitchPort(redis),
    spend: { ...tenant, ...platform },
    suppressions: suppressionPort(tx),
    consents: consentPort(tx),
    flags: flagPort(tx),
    dnd: dndPort(tx),
    attempts: attemptPort(tx),
    concurrency: concurrencyPort(redis),
    numbers: numberPort(tx),
    scripts: scriptPort(tx),
  };
}

export { loadGateInput };
