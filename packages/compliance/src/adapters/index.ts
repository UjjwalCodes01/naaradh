import type { Redis } from 'ioredis';
import type { Tx } from '@naaradh/db';
import { money, type Money } from '@naaradh/shared';
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
  type PlatformCaps,
} from './redis.js';

export * from './db.js';
export * from './redis.js';
export * from './dnd.js';
export * from './dnd-registry.js';

/** The per-currency caps the gate checks, from the deployment's configuration. */
export function platformCaps(config: GateDepsConfig): PlatformCaps {
  const engines = new Set([
    ...Object.keys(config.engineDailyCapPaise),
    ...Object.keys(config.engineDailyCapUsdCents ?? {}),
  ]);
  const engineDaily: Record<string, Money[]> = {};
  for (const engine of engines) {
    const caps: Money[] = [];
    const inr = config.engineDailyCapPaise[engine];
    const usd = config.engineDailyCapUsdCents?.[engine];
    if (inr !== undefined) caps.push(money(inr, 'INR'));
    if (usd !== undefined) caps.push(money(usd, 'USD'));
    engineDaily[engine] = caps;
  }
  const globalDaily: Money[] = [];
  if (config.globalDailyCapPaise !== null)
    globalDaily.push(money(config.globalDailyCapPaise, 'INR'));
  if (config.globalDailyCapUsdCents !== undefined && config.globalDailyCapUsdCents !== null)
    globalDaily.push(money(config.globalDailyCapUsdCents, 'USD'));
  return { engineDaily, globalDaily };
}

export interface GateDepsConfig {
  readonly engines: EngineConfig;
  /** Rupee caps: per engine, and across all engines. */
  readonly engineDailyCapPaise: Readonly<Record<string, number>>;
  readonly globalDailyCapPaise: number | null;
  /** Dollar caps (P6): engines that bill in USD — Retell. Unset → dollar spend is uncapped. */
  readonly engineDailyCapUsdCents?: Readonly<Record<string, number>>;
  readonly globalDailyCapUsdCents?: number | null;
  /** ADR-0012: the region this deployment serves. Every other region's tenant is refused. */
  readonly dataRegion?: string;
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
  const platform = platformSpend(redis, platformCaps(config), () => now);
  return {
    ...(config.dataRegion === undefined ? {} : { dataRegion: config.dataRegion }),
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
