import {
  ShopifyAuthError,
  ShopifyRequestError,
  ShopifyUserError,
  applyOrderWriteback,
  createAdminClient,
} from '@naaradh/shopify-sdk';
import type { SecretResolver } from '../deliveries/secrets.js';
import type { ShopifyWriteback } from './writeback.js';

/**
 * The production write-back port (P1-SHOP-2): resolves the store's Admin API token from
 * `integrations.credentials_secret_ref` (Secret Manager), then applies the plan to each order.
 * Dev, CI and tests use `recordingWriteback()` instead — nothing outside production calls a
 * real store, the same rule as the simulator for engines.
 */
export class StoreNotConnectedError extends Error {
  constructor() {
    super('Shopify store has no Admin API credentials — reconnect the app');
    this.name = 'StoreNotConnectedError';
  }
}

export function shopifyWriteback(deps: {
  readonly secrets: SecretResolver;
  readonly apiVersion: string;
  readonly fetchImpl?: typeof fetch;
}): ShopifyWriteback {
  return {
    async apply(_tenantId, store, orderIds, plan) {
      if (store.credentialsSecretRef === null) throw new StoreNotConnectedError();
      const accessToken = await deps.secrets.resolve(store.credentialsSecretRef);
      const client = createAdminClient({
        shop: store.shopDomain,
        accessToken,
        apiVersion: deps.apiVersion,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      });
      for (const orderId of orderIds) {
        await applyOrderWriteback(client, orderId, {
          tags: plan.tags,
          note: plan.note,
          metafields: plan.metafields,
          cancelOrder: plan.cancelOrder,
        });
      }
    },
  };
}

/**
 * Whether trying the same write-back again later can succeed. A revoked token, a missing
 * store connection, a malformed request or a business refusal from Shopify will fail the same
 * way every time — retrying them only delays the human who has to act.
 */
export function isRetryableWritebackError(error: unknown): boolean {
  return !(
    error instanceof ShopifyAuthError ||
    error instanceof ShopifyRequestError ||
    error instanceof ShopifyUserError ||
    error instanceof StoreNotConnectedError
  );
}
