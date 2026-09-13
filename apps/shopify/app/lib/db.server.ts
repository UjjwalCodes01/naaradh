import { createDb, type Db } from '@naaradh/db';
import { parseSecretKey } from '@naaradh/shared';
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

export function tokenKeyring(): ReadonlyMap<number, Buffer> {
  const k = tokenKey();
  return new Map([[k.kid, k.key]]);
}
