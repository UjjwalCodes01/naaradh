import { sql } from 'drizzle-orm';
import { bigint, customType, text, timestamp } from 'drizzle-orm/pg-core';

/** All timestamps are timestamptz, stored UTC, read as Date. Never `timestamp` without zone. */
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAt = () => ts('created_at').notNull().defaultNow();
/** Maintained by the `set_updated_at` trigger (migration 0001), not by application code. */
export const updatedAt = () => ts('updated_at').notNull().defaultNow();

/**
 * Money: integer minor units (paise / cents) with the currency beside it. `mode: 'number'`
 * is exact for integers below 2^53 — ₹90 trillion in paise — which is plenty. Never numeric
 * or float for money.
 */
export const minorUnits = (name: string) => bigint(name, { mode: 'number' });

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/** Case-insensitive text (extension `citext`, created by the bootstrap script). */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/** Crockford base32 ULID body, as produced by @naaradh/shared `newId`. */
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';

/** Prefixed-ULID primary key. Pair with `idFormat()` in a CHECK so the prefix is enforced. */
export const id = () => text('id').primaryKey();

/**
 * CHECK expression asserting a column holds a `<prefix>_<ULID>` id, so a row can never be
 * created with an id of the wrong kind (an attempt id where an intent id belongs) or a
 * hand-typed value.
 */
export const idFormat = (column: { name: string }, prefix: string) =>
  sql`${sql.identifier(column.name)} ~ '^${sql.raw(prefix)}_${sql.raw(ULID)}$'`;

/** HMAC-SHA256 hex digest of the E.164 number — the only phone representation used in lookups. */
export const phoneHash = (name = 'phone_hash') => text(name);
