import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type DbOrTx, type Tx } from '@naaradh/db';

/**
 * The region directory (ADR-0012 §4, P6-INF-2): which deployment serves a shop domain or one of
 * our phone numbers. It holds no personal data — a myshopify domain, a number we rent, a region
 * — and is replicated to every deployment so the edge can send a webhook to the right one.
 *
 * Each deployment is the only writer of its own rows (`source`): it derives them from its own
 * tables, applies them locally, and pushes the same snapshot to its peers. A peer accepts a
 * snapshot only for the sender's region, so one deployment can never claim another's shops.
 */

export const DATA_REGIONS = schema.dataRegion.enumValues;
type DataRegion = (typeof DATA_REGIONS)[number];

const shopKey = z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/);
const numberKey = z.string().regex(/^\+[1-9][0-9]{7,14}$/);

export const DirectoryEntry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shop'), key: shopKey }).strict(),
  z.object({ kind: z.literal('number'), key: numberKey }).strict(),
]);
export type DirectoryEntry = z.infer<typeof DirectoryEntry>;

/** What one deployment sends its peers: every entry it serves, as a full snapshot. */
export const DirectorySnapshot = z
  .object({
    source: z.enum(DATA_REGIONS),
    generated_at: z.string().datetime(),
    entries: z.array(DirectoryEntry).max(200_000),
  })
  .strict();
export type DirectorySnapshot = z.infer<typeof DirectorySnapshot>;

/**
 * This deployment's own entries: installed Shopify stores of in-region tenants, and every number
 * it rents that is not retired (pool numbers included — a call to one must reach this region).
 * Service role.
 */
export async function localDirectoryEntries(
  tx: DbOrTx,
  region: DataRegion,
): Promise<DirectoryEntry[]> {
  const shops = await tx
    .select({ key: schema.integrations.externalId })
    .from(schema.integrations)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.integrations.tenantId))
    .where(
      and(
        eq(schema.integrations.kind, 'shopify'),
        eq(schema.integrations.status, 'active'),
        eq(schema.tenants.dataRegion, region),
      ),
    );
  const numbers = await tx
    .select({ key: schema.numbers.e164 })
    .from(schema.numbers)
    .leftJoin(schema.tenants, eq(schema.tenants.id, schema.numbers.tenantId))
    .where(
      and(
        ne(schema.numbers.status, 'retired'),
        sql`(${schema.numbers.tenantId} is null or ${schema.tenants.dataRegion} = ${region})`,
      ),
    );
  const out: DirectoryEntry[] = [];
  for (const s of shops) {
    const key = s.key.toLowerCase();
    if (shopKey.safeParse(key).success) out.push({ kind: 'shop', key });
  }
  for (const n of numbers) out.push({ kind: 'number', key: n.key });
  return out;
}

export interface DirectoryApplied {
  readonly upserted: number;
  readonly removed: number;
  /** Keys another region already owns; left untouched (the owner must release them first). */
  readonly conflicts: number;
}

/**
 * Replace every row owned by `snapshot.source` with the snapshot. Rows owned by another region
 * are never overwritten: a shop that moved regions (uninstall in one, install in another) is
 * released by its old owner's next snapshot, then claimed by the new owner's. Service role.
 */
export async function applyDirectorySnapshot(
  tx: Tx,
  snapshot: DirectorySnapshot,
): Promise<DirectoryApplied> {
  const src = snapshot.source;
  const t = schema.regionDirectory;
  let upserted = 0;
  let conflicts = 0;
  for (const kind of ['shop', 'number'] as const) {
    const keys = [...new Set(snapshot.entries.filter((e) => e.kind === kind).map((e) => e.key))];
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      const rows = await tx
        .insert(t)
        .values(batch.map((key) => ({ kind, key, dataRegion: src, source: src })))
        .onConflictDoUpdate({
          target: [t.kind, t.key],
          set: { dataRegion: src, updatedAt: sql`now()` },
          setWhere: eq(t.source, src),
        })
        .returning({ key: t.key });
      upserted += rows.length;
      conflicts += batch.length - rows.length;
    }
  }
  // Everything this source owned and no longer lists is released: every listed row was just
  // touched (updated_at = this transaction's now()), so the older ones are the unlisted ones.
  const removed = (
    await tx
      .delete(t)
      .where(and(eq(t.source, src), sql`${t.updatedAt} < now()`))
      .returning({ key: t.key })
  ).length;
  return { upserted, removed, conflicts };
}

/** Which region serves this shop or number, if any deployment has claimed it. */
export async function lookupRegion(
  tx: DbOrTx,
  kind: 'shop' | 'number',
  key: string,
): Promise<DataRegion | null> {
  const [row] = await tx
    .select({ region: schema.regionDirectory.dataRegion })
    .from(schema.regionDirectory)
    .where(
      and(
        eq(schema.regionDirectory.kind, kind),
        eq(schema.regionDirectory.key, kind === 'shop' ? key.toLowerCase() : key),
      ),
    )
    .limit(1);
  return row?.region ?? null;
}
