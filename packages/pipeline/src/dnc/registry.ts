import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@naaradh/db';
import { hashPhone, normalizePhone } from '@naaradh/shared';

/**
 * Loading a national do-not-call registry file (P6-CMP-1) into `dnc_registry_entries`, by hash.
 * The screening provider that reads it is `registryDndProvider` in packages/compliance.
 *
 *   US National DNC Registry — telemarketers download it by area code with a SAN
 *     (subscription account number). The data file is one number per line, area code and number
 *     either comma-separated ("201,5550123") or run together ("2015550123").
 *   UK TPS / CTPS — licensed data files, one number per line in national format ("01632…") or
 *     with the country code ("441632…").
 *
 * A load is a VERSION. Rows are written under the new version while the old one stays in force;
 * only when every line has been read does the list switch to the new version, and only then are
 * the old version's rows deleted. A load that dies half-way leaves the previous version active
 * (until it goes stale, when screening fails closed). Re-running the same version is harmless.
 *
 * No number from the file is ever logged, returned or stored in the clear: a line that does not
 * parse is counted, nothing more (invariant 8).
 */

export interface DncListSpec {
  /** us_national · us_state_<xx> · uk_tps · uk_ctps */
  readonly list: string;
  readonly region: 'US' | 'GB';
  readonly required: boolean;
  readonly maxAgeDays: number;
  /** US partial subscription: the area codes this file covers. Null = the whole list. */
  readonly areaCodes: readonly string[] | null;
}

export interface DncLoadResult {
  readonly list: string;
  readonly version: string;
  readonly accepted: number;
  readonly rejected: number;
  readonly deleted: number;
}

const LIST_NAME = /^(us_national|us_state_[a-z]{2}|uk_tps|uk_ctps)$/;
const VERSION = /^[A-Za-z0-9._-]{1,40}$/;

/** One registry line → E.164, or null. Pure; the plaintext never leaves this function's caller. */
export function parseRegistryLine(line: string, region: 'US' | 'GB'): string | null {
  const digits = line.replace(/\D/g, '');
  let e164: string | null = null;
  if (region === 'US') {
    if (digits.length === 10) e164 = `+1${digits}`;
    else if (digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  } else {
    if (digits.startsWith('44') && digits.length >= 11) e164 = `+${digits}`;
    else if (digits.startsWith('0') && digits.length >= 10) e164 = `+44${digits.slice(1)}`;
  }
  if (e164 === null) return null;
  const parsed = normalizePhone(e164);
  if (!parsed.ok) return null;
  return parsed.phone.e164;
}

export async function loadDncRegistry(
  db: Db,
  input: {
    readonly spec: DncListSpec;
    readonly version: string;
    readonly hashKey: string;
    readonly lines: AsyncIterable<string>;
    readonly now: () => Date;
    /**
     * When the file was downloaded from the registry. Freshness (US 31 days, TPS 28) runs from
     * the DATA's date, not from when we loaded it: a 40-day-old download loaded today is already
     * stale. Defaults to now only for callers that download and load in one step.
     */
    readonly downloadedAt?: Date;
    readonly batchSize?: number;
  },
): Promise<DncLoadResult> {
  const { spec, version } = input;
  const asOf = input.downloadedAt ?? input.now();
  const ageMs = input.now().getTime() - asOf.getTime();
  if (ageMs < -86_400_000) throw new Error('the download date is in the future');
  if (ageMs > spec.maxAgeDays * 86_400_000)
    throw new Error(
      `the file was downloaded more than ${String(spec.maxAgeDays)} days ago; download a fresh copy`,
    );
  if (!LIST_NAME.test(spec.list)) throw new Error(`unknown DNC list ${spec.list}`);
  if (!VERSION.test(version)) throw new Error('version must be 1–40 of [A-Za-z0-9._-]');
  if (spec.list.startsWith('us_') !== (spec.region === 'US'))
    throw new Error(`list ${spec.list} does not belong to region ${spec.region}`);
  if (spec.areaCodes !== null && spec.areaCodes.some((a) => !/^[2-9]\d\d$/.test(a)))
    throw new Error('area codes are three digits, 200–999');

  // The list row exists before any entry references it, but is not switched to this version yet.
  await db
    .insert(schema.dncRegistryLists)
    .values({
      list: spec.list,
      region: spec.region,
      required: spec.required,
      maxAgeDays: spec.maxAgeDays,
    })
    .onConflictDoUpdate({
      target: schema.dncRegistryLists.list,
      set: { region: spec.region, required: spec.required, maxAgeDays: spec.maxAgeDays },
    });

  const size = input.batchSize ?? 5_000;
  let accepted = 0;
  let rejected = 0;
  let batch = new Set<string>();
  const flush = async () => {
    if (batch.size === 0) return;
    await db
      .insert(schema.dncRegistryEntries)
      .values([...batch].map((phoneHash) => ({ phoneHash, list: spec.list, version })))
      .onConflictDoNothing();
    batch = new Set();
  };

  for await (const line of input.lines) {
    if (line.trim() === '') continue;
    const e164 = parseRegistryLine(line, spec.region);
    if (e164 === null) {
      rejected += 1;
      continue;
    }
    // A number outside the subscribed area codes cannot come from this file: count it, skip it.
    if (spec.areaCodes !== null && !spec.areaCodes.includes(e164.slice(2, 5))) {
      rejected += 1;
      continue;
    }
    const before = batch.size;
    batch.add(hashPhone(e164, input.hashKey));
    if (batch.size > before) accepted += 1;
    if (batch.size >= size) await flush();
  }
  await flush();

  if (accepted === 0)
    throw new Error('the file produced no numbers; refusing to replace a list with an empty one');

  await db
    .update(schema.dncRegistryLists)
    .set({
      activeVersion: version,
      // "Fresh as of": the download date (see downloadedAt), which the screening provider ages.
      loadedAt: asOf,
      rowCount: accepted,
      areaCodes: spec.areaCodes === null ? null : [...spec.areaCodes],
    })
    .where(eq(schema.dncRegistryLists.list, spec.list));

  // Old versions go only after the switch, in batches so a large list never holds one long lock.
  let deleted = 0;
  for (;;) {
    const res = await db.execute(sql`
      delete from dnc_registry_entries
      where ctid in (
        select ctid from dnc_registry_entries
        where list = ${spec.list} and version <> ${version}
        limit 50000
      )`);
    const n = res.rowCount ?? 0;
    deleted += n;
    if (n === 0) break;
  }
  return { list: spec.list, version, accepted, rejected, deleted };
}

/** Lists as the dashboard and runbook show them: when each was loaded and whether it is stale. */
export async function dncRegistryStatus(db: Db, now: Date) {
  const rows = await db.select().from(schema.dncRegistryLists);
  return rows.map((l) => ({
    list: l.list,
    region: l.region,
    required: l.required,
    active_version: l.activeVersion,
    loaded_at: l.loadedAt,
    row_count: l.rowCount,
    area_codes: l.areaCodes,
    stale: l.loadedAt === null || now.getTime() - l.loadedAt.getTime() > l.maxAgeDays * 86_400_000,
  }));
}
