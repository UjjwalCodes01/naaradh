import { z } from 'zod';
import {
  CUSTOMER_PHONE_COLUMNS,
  STAFF_PHONE_COLUMNS,
  rotateEncryptedPhoneColumn,
  type EncryptedPhoneColumn,
} from '@naaradh/pipeline';
import { maintenanceEnv, runMaintenance } from './common.js';

/**
 * Shared body of `rotate-phone-enc-key` (customer pair: contacts) and `rotate-staff-enc-key`
 * (staff pair: transfer targets, inbound fallback numbers). Env:
 *   ROTATE_FROM_KID          kid being retired
 *   ROTATE_FROM_PRIVATE_KEY  its PRIVATE key (PEM) — the only thing that can open those rows
 *   ROTATE_TO_KID            new kid
 *   ROTATE_TO_PUBLIC_KEY     new PUBLIC key (PEM); the new private key is never needed here
 * Run from a trusted machine that pulled both keys from Secret Manager; no service holds two
 * private keys (AGENTS §4). Idempotent; run until `remaining` is 0.
 */
const schema = z.object({
  ...maintenanceEnv,
  ROTATE_FROM_KID: z.coerce.number().int().positive(),
  ROTATE_FROM_PRIVATE_KEY: z.string().includes('BEGIN PRIVATE KEY'),
  ROTATE_TO_KID: z.coerce.number().int().positive(),
  ROTATE_TO_PUBLIC_KEY: z.string().includes('BEGIN PUBLIC KEY'),
});

export async function rotatePhoneKeys(
  name: string,
  columns: readonly EncryptedPhoneColumn[],
): Promise<never> {
  return runMaintenance(name, schema, async (env, db) => {
    const results = [];
    for (const column of columns)
      results.push(
        await rotateEncryptedPhoneColumn(
          db,
          column,
          {
            fromKid: env.ROTATE_FROM_KID,
            fromPrivateKeyPem: env.ROTATE_FROM_PRIVATE_KEY,
            toKid: env.ROTATE_TO_KID,
            toPublicKeyPem: env.ROTATE_TO_PUBLIC_KEY,
          },
          { batch: env.ROTATION_BATCH, actorId: name },
        ),
      );
    return results;
  });
}

export const CUSTOMER = CUSTOMER_PHONE_COLUMNS;
export const STAFF = STAFF_PHONE_COLUMNS;
