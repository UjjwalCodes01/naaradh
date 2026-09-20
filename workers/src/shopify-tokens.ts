import { eq, sql } from 'drizzle-orm';
import { schema, type Db, type DbOrTx } from '@naaradh/db';
import { ShopifyAuthError, refreshOfflineToken } from '@naaradh/shopify-sdk';
import { openSealed, seal } from '@naaradh/shared';
import type { SecretResolver } from './deliveries/secrets.js';

/**
 * Resolves `shopify-session:<session id>` credential refs (ADR-0007) to a usable Admin API
 * token for the workers that call Shopify (writebacks, actions, billing, reconcile). Service
 * role: reads `shopify_sessions` directly and decrypts with SHOPIFY_TOKEN_KEY.
 *
 * Offline tokens expire hourly for new public apps. A token with under 5 minutes left is
 * refreshed here, serialised per session by a transaction-scoped advisory lock so two workers
 * never spend the same refresh token. The embedded app's token exchange can replace the pair
 * at any moment (invalidating our refresh token): on a 401 we re-read the row once and use
 * whatever the app stored, and only then report the store as disconnected.
 *
 * Every other ref goes to the base resolver (Secret Manager / inline).
 */

export const SHOPIFY_SESSION_REF = 'shopify-session:';
const REFRESH_MARGIN_MS = 5 * 60_000;

interface Sealed {
  accessToken: string;
  refreshToken?: string;
  refreshTokenExpires?: string;
}

export interface ShopifyTokenDeps {
  readonly service: Db;
  /** kid → 32-byte key; the newest kid seals refreshed tokens. */
  readonly keys: ReadonlyMap<number, Buffer>;
  readonly currentKid: number;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly now: () => Date;
  readonly fetchImpl?: typeof fetch;
}

type SessionRow = typeof schema.shopifySessions.$inferSelect;

function unseal(deps: ShopifyTokenDeps, row: SessionRow): Sealed {
  const key = deps.keys.get(row.secretKid);
  if (key === undefined) throw new ShopifyAuthError(401);
  try {
    const v = JSON.parse(
      openSealed(
        key,
        { ciphertext: row.secretCiphertext, iv: row.secretIv, tag: row.secretTag },
        row.id,
      ),
    ) as Sealed;
    if (typeof v.accessToken !== 'string') throw new Error('no token');
    return v;
  } catch {
    // Wrong key or tampered row: treat as disconnected, never use garbage as a token.
    throw new ShopifyAuthError(401);
  }
}

function usable(row: SessionRow, now: Date): boolean {
  return row.expiresAt === null || row.expiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS;
}

export function shopifyTokenResolver(base: SecretResolver, deps: ShopifyTokenDeps): SecretResolver {
  const load = async (db: DbOrTx, id: string, lock: boolean): Promise<SessionRow | undefined> => {
    const q = db
      .select()
      .from(schema.shopifySessions)
      .where(eq(schema.shopifySessions.id, id))
      .limit(1);
    const [row] = lock ? await q.for('update') : await q;
    return row;
  };

  return {
    async resolve(ref) {
      if (!ref.startsWith(SHOPIFY_SESSION_REF)) return base.resolve(ref);
      const id = ref.slice(SHOPIFY_SESSION_REF.length);
      const first = await load(deps.service, id, false);
      if (first === undefined) throw new ShopifyAuthError(401);
      if (usable(first, deps.now())) return unseal(deps, first).accessToken;

      return deps.service.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`shopify_refresh:${id}`}))`);
        const row = await load(tx, id, true);
        if (row === undefined) throw new ShopifyAuthError(401);
        const now = deps.now();
        const current = unseal(deps, row);
        if (usable(row, now)) return current.accessToken; // someone refreshed while we waited
        if (current.refreshToken === undefined) throw new ShopifyAuthError(401);
        let fresh;
        try {
          fresh = await refreshOfflineToken({
            shop: row.shop,
            clientId: deps.clientId,
            clientSecret: deps.clientSecret,
            refreshToken: current.refreshToken,
            now,
            ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
          });
        } catch (error) {
          if (!(error instanceof ShopifyAuthError)) throw error;
          // The embedded app may have replaced the pair (token exchange) since we read it.
          const again = await load(deps.service, id, false);
          if (again !== undefined && usable(again, deps.now()))
            return unseal(deps, again).accessToken;
          throw error;
        }
        const key = deps.keys.get(deps.currentKid);
        if (key === undefined)
          throw new Error(`SHOPIFY_TOKEN_KEY kid ${String(deps.currentKid)} missing`);
        const sealed = seal(
          key,
          deps.currentKid,
          JSON.stringify({
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken,
            ...(fresh.refreshTokenExpiresAt === null
              ? {}
              : { refreshTokenExpires: fresh.refreshTokenExpiresAt.toISOString() }),
          }),
          row.id,
        );
        await tx
          .update(schema.shopifySessions)
          .set({
            expiresAt: fresh.expiresAt,
            secretCiphertext: sealed.ciphertext,
            secretIv: sealed.iv,
            secretTag: sealed.tag,
            secretKid: sealed.kid,
            ...(fresh.scope === null ? {} : { scope: fresh.scope }),
          })
          .where(eq(schema.shopifySessions.id, row.id));
        return fresh.accessToken;
      });
    },
  };
}
