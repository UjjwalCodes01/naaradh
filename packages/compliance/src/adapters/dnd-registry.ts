import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import { hashPhone } from '@naaradh/shared';
import type { DndResult } from '../gate/types.js';
import type { DndProvider } from './dnd.js';

/**
 * Screening against national do-not-call registries loaded from their licensed files
 * (P6-CMP-1): the US National DNC Registry and the UK TPS/CTPS. The files are loaded by
 * `loadDncRegistry()` (packages/pipeline), hashed with the same key as every other lookup, so
 * this provider answers from the database by hash — no customer number leaves Naaradh to be
 * screened, and no registry number is ever stored in the clear.
 *
 * It fails CLOSED ('unknown' → the gate refuses a marketing call and asks again later) whenever
 * the answer could be wrong:
 *
 *   - a list the region requires has never been loaded, or its last complete load is older than
 *     the law allows (US: 31 days, 16 CFR 310.4(b)(3)(iv); UK TPS licence: 28 days);
 *   - a US national subscription that covers only some area codes does not cover this number's
 *     (a state list's area codes only mark its state, and never make other numbers unknown);
 *   - an optional list that WAS loaded (a state list, CTPS) has since gone stale — once a
 *     merchant relies on a list, a stale copy is not an answer.
 */

/** The lists without which a region cannot be screened at all. */
export const REQUIRED_DNC_LISTS: Readonly<Record<string, readonly string[]>> = {
  US: ['us_national'],
  GB: ['uk_tps'],
};

/** How old a load may be before it is not trusted, by list family. */
export const DNC_MAX_AGE_DAYS: Readonly<Record<string, number>> = {
  US: 31,
  GB: 28,
};

export interface RegistryProviderOptions {
  readonly hashKey: string;
  readonly now?: () => Date;
}

export function registryDndProvider(db: DbOrTx, options: RegistryProviderOptions): DndProvider {
  const now = options.now ?? (() => new Date());
  return {
    name: 'dnc_registry',
    async check(e164, region): Promise<DndResult> {
      const required = REQUIRED_DNC_LISTS[region];
      if (required === undefined) return 'unknown';
      const lists = await db
        .select()
        .from(schema.dncRegistryLists)
        .where(eq(schema.dncRegistryLists.region, region));
      const at = now().getTime();
      const fresh = (l: (typeof lists)[number]) =>
        l.activeVersion !== null &&
        l.loadedAt !== null &&
        at - l.loadedAt.getTime() <= l.maxAgeDays * 86_400_000;

      for (const name of required) {
        const list = lists.find((l) => l.list === name);
        if (list === undefined || !fresh(list)) return 'unknown';
      }
      const active = lists.filter((l) => l.activeVersion !== null);
      if (active.some((l) => !fresh(l))) return 'unknown';

      if (region === 'US') {
        const areaCode = e164.startsWith('+1') && e164.length === 12 ? e164.slice(2, 5) : null;
        if (areaCode === null) return 'unknown';
        // A partial NATIONAL subscription answers only for the area codes it paid for. A state
        // list's area codes just say where that state is: a number elsewhere is simply not on it.
        if (
          active.some((l) => l.required && l.areaCodes !== null && !l.areaCodes.includes(areaCode))
        )
          return 'unknown';
      }

      const phoneHash = hashPhone(e164, options.hashKey);
      const hit = await db
        .select({ one: sql<number>`1` })
        .from(schema.dncRegistryEntries)
        .where(
          and(
            eq(schema.dncRegistryEntries.phoneHash, phoneHash),
            inArray(
              schema.dncRegistryEntries.list,
              active.map((l) => l.list),
            ),
            or(
              ...active.map((l) =>
                and(
                  eq(schema.dncRegistryEntries.list, l.list),
                  eq(schema.dncRegistryEntries.version, l.activeVersion ?? ''),
                ),
              ),
            ),
          ),
        )
        .limit(1);
      return hit.length > 0 ? 'registered' : 'not_registered';
    },
  };
}

/**
 * One provider per recipient region; anything else gets the fallback (today `noDndProvider`,
 * i.e. every Indian marketing call waits for a TSP contract — ADR-0010 §6).
 */
export function regionalDndProvider(
  byRegion: Readonly<Record<string, DndProvider>>,
  fallback: DndProvider,
): DndProvider {
  return {
    name: 'regional',
    async check(e164, region) {
      return (byRegion[region] ?? fallback).check(e164, region);
    },
  };
}
