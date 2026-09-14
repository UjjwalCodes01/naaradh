import { createDb, type Db } from '@naaradh/db';
import { parseSecretKey, shopifyTokenKeyring } from '@naaradh/shared';
import { env } from './env.server';

const g = globalThis as typeof globalThis & { __naaradhShopifyDb?: Db };

/** The app role (RLS). Created on first use so builds need no database. */
export function db(): Db {
  g.__naaradhShopifyDb ??= createDb({
    url: env().DATABASE_URL,
    max: 5,
    applicationName: 'naaradh-shopify',
  }).db;
  return g.__naaradhShopifyDb;
}

export function tokenKey(): { key: Buffer; kid: number } {
  return { key: parseSecretKey(env().SHOPIFY_TOKEN_KEY), kid: env().SHOPIFY_TOKEN_KID };
}

/**
 * Every key that may OPEN a stored session: the current one and, during a rotation
 * (docs/runbooks/secret-rotation.md), the previous one. Sealing uses tokenKey() only.
 */
export function tokenKeyring(): ReadonlyMap<number, Buffer> {
  const e = env();
  return shopifyTokenKeyring({
    SHOPIFY_TOKEN_KEY: e.SHOPIFY_TOKEN_KEY,
    SHOPIFY_TOKEN_KID: e.SHOPIFY_TOKEN_KID,
    SHOPIFY_TOKEN_KEY_PREVIOUS: e.SHOPIFY_TOKEN_KEY_PREVIOUS,
    SHOPIFY_TOKEN_KID_PREVIOUS: e.SHOPIFY_TOKEN_KID_PREVIOUS,
  }).keys;
}
