import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@naaradh/db';
import { newId, openSealed, seal } from '@naaradh/shared';

/**
 * The Shopify app's pre-tenant database access (ADR-0007, ADR-0009): session storage and
 * install provisioning through the SECURITY DEFINER functions of migration 0009. The app role
 * never reads `shopify_sessions` directly, and the service role never serves the embedded app.
 *
 * The sealed secret is JSON `{ accessToken, refreshToken?, refreshTokenExpires? }`, AES-256-GCM
 * under SHOPIFY_TOKEN_KEY with the session id as additional authenticated data.
 */

export function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`array[]::text[]`;
  return sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

export interface TokenKey {
  readonly key: Buffer;
  readonly kid: number;
}

export interface StoredShopifySession {
  readonly id: string;
  readonly shop: string;
  readonly state: string;
  readonly isOnline: boolean;
  readonly scope: string | null;
  readonly expires: Date | null;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly refreshTokenExpires: Date | null;
  readonly onlineAccessInfo: unknown;
}

type Row = {
  id: string;
  shop: string;
  state: string;
  is_online: boolean;
  scope: string | null;
  expires_at: Date | string | null;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_tag: Buffer;
  secret_kid: number;
  online_access_info: unknown;
};

function fromRow(row: Row, keys: ReadonlyMap<number, Buffer>): StoredShopifySession | null {
  const key = keys.get(row.secret_kid);
  if (key === undefined) return null;
  let secret: { accessToken?: string; refreshToken?: string; refreshTokenExpires?: string };
  try {
    secret = JSON.parse(
      openSealed(
        key,
        { ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag },
        row.id,
      ),
    ) as typeof secret;
  } catch {
    // Wrong key or tampered row: behave as "no session" so the app re-authenticates.
    return null;
  }
  if (typeof secret.accessToken !== 'string') return null;
  return {
    id: row.id,
    shop: row.shop,
    state: row.state,
    isOnline: row.is_online,
    scope: row.scope,
    expires: row.expires_at === null ? null : new Date(row.expires_at),
    accessToken: secret.accessToken,
    refreshToken: secret.refreshToken ?? null,
    refreshTokenExpires:
      secret.refreshTokenExpires === undefined ? null : new Date(secret.refreshTokenExpires),
    onlineAccessInfo: row.online_access_info,
  };
}

export async function storeShopifySession(
  db: Db,
  key: TokenKey,
  s: Omit<StoredShopifySession, 'onlineAccessInfo'> & { readonly onlineAccessInfo?: unknown },
): Promise<void> {
  const sealed = seal(
    key.key,
    key.kid,
    JSON.stringify({
      accessToken: s.accessToken,
      ...(s.refreshToken === null ? {} : { refreshToken: s.refreshToken }),
      ...(s.refreshTokenExpires === null
        ? {}
        : { refreshTokenExpires: s.refreshTokenExpires.toISOString() }),
    }),
    s.id,
  );
  const info =
    s.onlineAccessInfo === undefined || s.onlineAccessInfo === null
      ? null
      : JSON.stringify(s.onlineAccessInfo);
  await db.execute(
    sql`select shopify_session_store(${s.id}, ${s.shop}, ${s.state}, ${s.isOnline}, ${s.scope}, ${s.expires}, ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.kid}::smallint, ${info}::jsonb)`,
  );
}

export async function loadShopifySession(
  db: Db,
  keys: ReadonlyMap<number, Buffer>,
  id: string,
): Promise<StoredShopifySession | null> {
  const r = await db.execute<Row>(sql`select * from shopify_session_load(${id})`);
  const row = r.rows[0];
  return row === undefined ? null : fromRow(row, keys);
}

export async function shopifySessionsForShop(
  db: Db,
  keys: ReadonlyMap<number, Buffer>,
  shop: string,
): Promise<StoredShopifySession[]> {
  const r = await db.execute<Row>(sql`select * from shopify_sessions_for_shop(${shop})`);
  return r.rows.flatMap((row) => {
    const s = fromRow(row, keys);
    return s === null ? [] : [s];
  });
}

export async function deleteShopifySessions(db: Db, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await db.execute<{ n: number }>(
    sql`select shopify_session_delete(${textArray(ids)}) as n`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

export interface InstallInput {
  readonly shop: string;
  readonly name: string;
  readonly country: string;
  readonly dataRegion: 'in' | 'us' | 'eu';
  readonly timezone: string;
  readonly currency: string;
  readonly ownerEmail: string | null;
  readonly scopes: readonly string[];
  readonly apiVersion: string;
  readonly now: Date;
}

export interface InstallResult {
  readonly tenantId: string;
  readonly created: boolean;
  readonly reinstalled: boolean;
}

/** First install → new tenant (pending review) + integration + owner; reinstall → lift the uninstall pause. */
export async function provisionShopifyInstall(db: Db, input: InstallInput): Promise<InstallResult> {
  const r = await db.execute<{ tenant_id: string; created: boolean; reinstalled: boolean }>(
    sql`select * from provision_shopify_install(${input.shop}, ${newId('tenant')}, ${newId('integration')}, ${newId('user')}, ${newId('audit')}, ${input.name}, ${input.country}, ${input.dataRegion}::data_region, ${input.timezone}, ${input.currency}, ${input.ownerEmail}::citext, ${textArray(input.scopes)}, ${input.apiVersion}, ${input.now})`,
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error('provision_shopify_install returned nothing');
  return { tenantId: row.tenant_id, created: row.created, reinstalled: row.reinstalled };
}

/** EU members (for data_region); anything not IN/US-ish/EU falls back to the strictest, 'eu'. */
const EU = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'IS',
  'LI',
  'NO',
  'GB',
  'CH',
]);

export function dataRegionFor(country: string): 'in' | 'us' | 'eu' {
  const c = country.toUpperCase();
  if (c === 'IN') return 'in';
  if (c === 'US' || c === 'CA') return 'us';
  if (EU.has(c)) return 'eu';
  return 'eu';
}
