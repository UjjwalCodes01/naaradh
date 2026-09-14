import { sql } from 'drizzle-orm';
import type { Db } from '@naaradh/db';
import { NaaradhError, decryptPhone, encryptPhone, openSealed, seal } from '@naaradh/shared';
import { audit } from './audit.js';
import type { TokenKey } from './shopify-install.js';

/**
 * Key rotation as re-encryption jobs (docs/runbooks/secret-rotation.md). Three ciphertext
 * families carry a `kid` beside them so a rotation is a job, never a guess:
 *
 *   shopify_sessions.secret_*            AES-256-GCM under SHOPIFY_TOKEN_KEY (ADR-0007)
 *   contacts.phone_enc                   RSA-OAEP under the CUSTOMER key pair (AGENTS §4)
 *   transfer_targets.phone_enc,
 *   inbound_profiles.fallback_forward_enc  RSA-OAEP under the STAFF key pair (invariant 19)
 *
 * Every function here is cross-tenant by definition and runs on the service role from a
 * one-shot maintenance process (apps/workers/src/maintenance). Rows are claimed in id-ordered
 * batches with `for update skip locked`, so a writer that holds a row keeps it and the job
 * moves on; a second run picks up whatever the first one could not. A row that cannot be
 * opened is counted as `failed` and left as it is — never dropped, never re-sealed with
 * garbage. Plaintext lives in memory for one row at a time and is never logged; the only
 * durable trace of a run is one audit_log row per table with counts.
 */

export interface RotationCounts {
  /** Rows re-encrypted under the target key in this run. */
  readonly rotated: number;
  /** Rows left alone because another transaction held them (they are still on the old kid). */
  readonly skipped: number;
  /** Rows that could not be opened with the keys supplied (wrong key, tampered bytes). */
  readonly failed: number;
  /** Rows still not on the target kid after this run — the number the operator drives to 0. */
  readonly remaining: number;
}

export interface RotationOptions {
  /** Rows per transaction. */
  readonly batch?: number;
  /** `audit_log.actor_id`, e.g. the job name. */
  readonly actorId?: string;
}

export const ROTATION_BATCH = 500;
export const KEY_ROTATED_ACTION = 'key.rotated';

function batchSize(options: RotationOptions): number {
  const n = options.batch ?? ROTATION_BATCH;
  if (!Number.isInteger(n) || n < 1 || n > 5000)
    throw new NaaradhError('VALIDATION_FAILED', 'rotation batch must be 1..5000', {
      context: { batch: n },
    });
  return n;
}

async function countInt(db: Db, query: ReturnType<typeof sql>): Promise<number> {
  const r = await db.execute<{ n: number | string }>(query);
  return Number(r.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Shopify sessions
// ---------------------------------------------------------------------------------------------

type SessionRow = {
  id: string;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_tag: Buffer;
  secret_kid: number;
};

/**
 * Re-seals every `shopify_sessions` row whose kid is not `current.kid`, opening it with the
 * keyring (which must contain the retiring key) and sealing with the current key under the
 * same AAD `storeShopifySession` uses — the session id — so nothing else about the row changes.
 *
 * Takes the same per-session advisory lock the workers' refresh path takes
 * (`shopify_refresh:<id>`, apps/workers/src/shopify-tokens.ts), non-blocking: a refresh in
 * flight keeps its lock, its row is `skipped` here, and the refresh itself seals the new token
 * under the current kid — so nothing is overwritten and the row ends up current either way.
 */
export async function rotateShopifySessions(
  db: Db,
  keys: ReadonlyMap<number, Buffer>,
  current: TokenKey,
  options: RotationOptions = {},
): Promise<RotationCounts> {
  const batch = batchSize(options);
  if (!keys.has(current.kid) || !keys.get(current.kid)?.equals(current.key))
    throw new NaaradhError('VALIDATION_FAILED', 'keyring must contain the current key', {
      context: { current_kid: current.kid },
    });

  let rotated = 0;
  let skipped = 0;
  let failed = 0;
  let cursor = '';
  for (;;) {
    const page = await db.transaction(async (tx) => {
      const r = await tx.execute<SessionRow>(
        sql`select id, secret_ciphertext, secret_iv, secret_tag, secret_kid
            from shopify_sessions
            where secret_kid <> ${current.kid} and id > ${cursor}
            order by id limit ${batch}
            for update skip locked`,
      );
      for (const row of r.rows) {
        const lock = await tx.execute<{ ok: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtext(${`shopify_refresh:${row.id}`})) as ok`,
        );
        if (lock.rows[0]?.ok !== true) {
          skipped += 1;
          continue;
        }
        const key = keys.get(row.secret_kid);
        if (key === undefined) {
          failed += 1;
          continue;
        }
        let plaintext: string;
        try {
          plaintext = openSealed(
            key,
            { ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag },
            row.id,
          );
        } catch {
          failed += 1;
          continue;
        }
        const sealed = seal(current.key, current.kid, plaintext, row.id);
        await tx.execute(
          sql`update shopify_sessions
              set secret_ciphertext = ${sealed.ciphertext}, secret_iv = ${sealed.iv},
                  secret_tag = ${sealed.tag}, secret_kid = ${sealed.kid}::smallint
              where id = ${row.id}`,
        );
        rotated += 1;
      }
      const last = r.rows.at(-1);
      return { n: r.rows.length, last: last?.id ?? cursor };
    });
    if (page.n < batch) break;
    cursor = page.last;
  }

  const remaining = await countInt(
    db,
    sql`select count(*) as n from shopify_sessions where secret_kid <> ${current.kid}`,
  );
  const counts = { rotated, skipped, failed, remaining };
  await audit(db, {
    tenantId: null,
    actorType: 'worker',
    actorId: options.actorId ?? 'rotate-shopify-token-key',
    action: KEY_ROTATED_ACTION,
    targetType: 'shopify_sessions',
    after: { column: 'secret_ciphertext', to_kid: current.kid, ...counts },
  });
  return counts;
}

// ---------------------------------------------------------------------------------------------
// RSA-OAEP phone columns (customer and staff key pairs)
// ---------------------------------------------------------------------------------------------

export interface EncryptedPhoneColumn {
  readonly table: 'contacts' | 'transfer_targets' | 'inbound_profiles';
  readonly encColumn: 'phone_enc' | 'fallback_forward_enc';
  readonly kidColumn: 'phone_enc_kid' | 'fallback_forward_kid';
}

/** Everything encrypted with PHONE_ENC_* (the customer pair). Extend when a column is added. */
export const CUSTOMER_PHONE_COLUMNS: readonly EncryptedPhoneColumn[] = [
  { table: 'contacts', encColumn: 'phone_enc', kidColumn: 'phone_enc_kid' },
];

/** Everything encrypted with STAFF_ENC_* (the staff pair, invariant 19). */
export const STAFF_PHONE_COLUMNS: readonly EncryptedPhoneColumn[] = [
  { table: 'transfer_targets', encColumn: 'phone_enc', kidColumn: 'phone_enc_kid' },
  {
    table: 'inbound_profiles',
    encColumn: 'fallback_forward_enc',
    kidColumn: 'fallback_forward_kid',
  },
];

export interface PhoneKeyRotation {
  readonly fromKid: number;
  /** The retiring PRIVATE key — the only thing that can open rows on `fromKid`. */
  readonly fromPrivateKeyPem: string;
  readonly toKid: number;
  /** The new PUBLIC key. The job never needs the new private key. */
  readonly toPublicKeyPem: string;
}

type PhoneRow = { id: string; enc: Buffer; kid: number };

/**
 * Decrypts every row of `column` on `fromKid` with the old private key and re-encrypts it with
 * the new public key under `toKid`. Rows on any other kid are not touched (the job holds
 * exactly one old private key) but are reported in `remaining`.
 */
export async function rotateEncryptedPhoneColumn(
  db: Db,
  column: EncryptedPhoneColumn,
  rotation: PhoneKeyRotation,
  options: RotationOptions = {},
): Promise<RotationCounts> {
  const batch = batchSize(options);
  if (rotation.fromKid === rotation.toKid)
    throw new NaaradhError('VALIDATION_FAILED', 'from and to kid must differ', {
      context: { kid: rotation.fromKid },
    });
  const table = sql.identifier(column.table);
  const enc = sql.identifier(column.encColumn);
  const kid = sql.identifier(column.kidColumn);

  let rotated = 0;
  let failed = 0;
  let cursor = '';
  for (;;) {
    const page = await db.transaction(async (tx) => {
      const r = await tx.execute<PhoneRow>(
        sql`select id, ${enc} as enc, ${kid} as kid from ${table}
            where ${kid} = ${rotation.fromKid} and ${enc} is not null and id > ${cursor}
            order by id limit ${batch}
            for update skip locked`,
      );
      for (const row of r.rows) {
        let e164: string;
        try {
          // The only moment a number is in memory: decrypt, re-encrypt, forget.
          e164 = decryptPhone(row.enc, rotation.fromPrivateKeyPem);
        } catch {
          failed += 1;
          continue;
        }
        const fresh = encryptPhone(e164, rotation.toPublicKeyPem, rotation.toKid);
        await tx.execute(
          sql`update ${table} set ${enc} = ${fresh.ciphertext}, ${kid} = ${fresh.kid}::smallint
              where id = ${row.id}`,
        );
        rotated += 1;
      }
      const last = r.rows.at(-1);
      return { n: r.rows.length, last: last?.id ?? cursor };
    });
    if (page.n < batch) break;
    cursor = page.last;
  }

  const stillFrom = await countInt(
    db,
    sql`select count(*) as n from ${table} where ${kid} = ${rotation.fromKid} and ${enc} is not null`,
  );
  const remaining = await countInt(
    db,
    sql`select count(*) as n from ${table} where ${kid} <> ${rotation.toKid} and ${enc} is not null`,
  );
  const counts = { rotated, skipped: Math.max(0, stillFrom - failed), failed, remaining };
  await audit(db, {
    tenantId: null,
    actorType: 'worker',
    actorId: options.actorId ?? `rotate-${column.table}`,
    action: KEY_ROTATED_ACTION,
    targetType: column.table,
    after: {
      column: column.encColumn,
      from_kid: rotation.fromKid,
      to_kid: rotation.toKid,
      ...counts,
    },
  });
  return counts;
}
