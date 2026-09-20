import { Session } from '@shopify/shopify-api';
import type { SessionStorage } from '@shopify/shopify-app-session-storage';
import {
  deleteShopifySessions,
  loadShopifySession,
  shopifySessionsForShop,
  storeShopifySession,
  type StoredShopifySession,
} from '@naaradh/pipeline';
import { db, tokenKey, tokenKeyring } from './db.server';

/**
 * Shopify sessions in Postgres (ADR-0007) through the SECURITY DEFINER functions of migration
 * 0009 — the embedded app never sees the table, and the access/refresh tokens are sealed with
 * SHOPIFY_TOKEN_KEY. The workers read the same rows (service role) to call the Admin API.
 */
function toSession(s: StoredShopifySession): Session {
  return new Session({
    id: s.id,
    shop: s.shop,
    state: s.state,
    isOnline: s.isOnline,
    ...(s.scope === null ? {} : { scope: s.scope }),
    ...(s.expires === null ? {} : { expires: s.expires }),
    accessToken: s.accessToken,
    ...(s.refreshToken === null ? {} : { refreshToken: s.refreshToken }),
    ...(s.refreshTokenExpires === null ? {} : { refreshTokenExpires: s.refreshTokenExpires }),
    ...(s.onlineAccessInfo === null || s.onlineAccessInfo === undefined
      ? {}
      : { onlineAccessInfo: s.onlineAccessInfo as NonNullable<Session['onlineAccessInfo']> }),
  });
}

export class NaaradhSessionStorage implements SessionStorage {
  async storeSession(session: Session): Promise<boolean> {
    if (session.accessToken === undefined) return false;
    await storeShopifySession(db(), tokenKey(), {
      id: session.id,
      shop: session.shop,
      state: session.state,
      isOnline: session.isOnline,
      scope: session.scope ?? null,
      expires: session.expires ?? null,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken ?? null,
      refreshTokenExpires: session.refreshTokenExpires ?? null,
      onlineAccessInfo: session.onlineAccessInfo ?? null,
    });
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const s = await loadShopifySession(db(), tokenKeyring(), id);
    return s === null ? undefined : toSession(s);
  }

  async deleteSession(id: string): Promise<boolean> {
    await deleteShopifySessions(db(), [id]);
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    await deleteShopifySessions(db(), ids);
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    return (await shopifySessionsForShop(db(), tokenKeyring(), shop)).map(toSession);
  }
}
