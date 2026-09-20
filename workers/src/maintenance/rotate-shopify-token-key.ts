import { z } from 'zod';
import { rotateShopifySessions } from '@naaradh/pipeline';
import { shopifyTokenEnv, shopifyTokenKeyring } from '@naaradh/shared';
import { maintenanceEnv, runMaintenance } from './common.js';

/**
 * Re-seals every `shopify_sessions` row that is not on the current kid (ADR-0007 rotation).
 * Env: the NEW key as SHOPIFY_TOKEN_KEY / SHOPIFY_TOKEN_KID, the retiring one as
 * SHOPIFY_TOKEN_KEY_PREVIOUS / SHOPIFY_TOKEN_KID_PREVIOUS, plus DATABASE_SERVICE_URL.
 * Idempotent; run until `remaining` is 0, then drop the *_PREVIOUS pair everywhere.
 */
const schema = z.object({ ...maintenanceEnv, ...shopifyTokenEnv });

await runMaintenance('rotate-shopify-token-key', schema, async (env, db) => {
  const ring = shopifyTokenKeyring(env);
  const current = ring.keys.get(ring.currentKid);
  if (current === undefined) throw new Error('current key missing from keyring');
  return [
    await rotateShopifySessions(
      db,
      ring.keys,
      { key: current, kid: ring.currentKid },
      { batch: env.ROTATION_BATCH, actorId: 'rotate-shopify-token-key' },
    ),
  ];
});
