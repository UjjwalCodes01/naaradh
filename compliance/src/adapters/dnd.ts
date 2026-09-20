import { eq } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import { addMinutes } from '@naaradh/shared';
import { DND_SCRUB_CACHE_HOURS } from '../constants.js';
import type { DndPort, DndResult } from '../gate/types.js';

/**
 * A DND/NCPR registry client. India: TSP/DLT scrub API (Q-02, Q-05 decide which). US: the
 * National DNC Registry via a SAN-registered provider (Phase 6). The provider needs the
 * plaintext number, which the gate does not have — so the scrub runs at INGESTION (where the
 * number is in hand) and the gate reads the cache keyed by hash. `scrub()` here therefore
 * returns 'unknown' on a cache miss and the gate applies its fail-closed/fail-open policy.
 */
export interface DndProvider {
  readonly name: string;
  check(e164: string, region: string): Promise<DndResult>;
}

/** Placeholder until a TSP contract exists: every lookup is 'unknown'. */
export const noDndProvider: DndProvider = {
  name: 'none',
  check: async () => 'unknown',
};

export function dndPort(db: DbOrTx): DndPort {
  return {
    async scrub(phoneHash, _region, now) {
      const [row] = await db
        .select({ result: schema.dndScrubCache.result, expiresAt: schema.dndScrubCache.expiresAt })
        .from(schema.dndScrubCache)
        .where(eq(schema.dndScrubCache.phoneHash, phoneHash))
        .limit(1);
      if (row === undefined || row.expiresAt <= now) return 'unknown';
      return row.result;
    },
  };
}

/** A cached result that is still fresh, or null. */
export async function cachedDnd(
  db: DbOrTx,
  phoneHash: string,
  now: Date,
): Promise<DndResult | null> {
  const [row] = await db
    .select({ result: schema.dndScrubCache.result, expiresAt: schema.dndScrubCache.expiresAt })
    .from(schema.dndScrubCache)
    .where(eq(schema.dndScrubCache.phoneHash, phoneHash))
    .limit(1);
  return row === undefined || row.expiresAt <= now ? null : row.result;
}

/**
 * Look the number up with the provider and cache the answer by hash for 24h. Runs where the
 * plaintext number is in hand — the dispatcher, just before the gate (ADR-0010 §6). A provider
 * failure or an 'unknown' answer is NOT cached: the gate refuses this time (fail-closed,
 * `dnd:unknown`, temporary) and the next attempt asks again instead of being blocked for a day.
 */
export async function refreshDnd(
  db: DbOrTx,
  provider: DndProvider,
  phoneHash: string,
  e164: string,
  region: string,
  now: Date,
): Promise<DndResult> {
  let result: DndResult;
  try {
    result = await provider.check(e164, region);
  } catch {
    return 'unknown';
  }
  if (result === 'unknown') return result;
  await db
    .insert(schema.dndScrubCache)
    .values({
      phoneHash,
      region,
      result,
      provider: provider.name,
      checkedAt: now,
      expiresAt: addMinutes(now, DND_SCRUB_CACHE_HOURS * 60),
    })
    .onConflictDoUpdate({
      target: schema.dndScrubCache.phoneHash,
      set: {
        region,
        result,
        provider: provider.name,
        checkedAt: now,
        expiresAt: addMinutes(now, DND_SCRUB_CACHE_HOURS * 60),
      },
    });
  return result;
}
