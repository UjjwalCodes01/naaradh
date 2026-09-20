import {
  ShopifyAuthError,
  ShopifyRequestError,
  ShopifyUserError,
  applyOrderWriteback,
  createAdminClient,
  fireCallCompletedTrigger,
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
  /**
   * Fire the Shopify Flow trigger "Naaradh call completed" after each order is written
   * (P2-SHOP-7). Off until the trigger extension has been released with `shopify app deploy`.
   */
  readonly flowTrigger?: boolean;
  readonly onFlowTriggerError?: (error: unknown) => void;
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
        if (deps.flowTrigger === true) {
          // A convenience for the merchant's automations, never a reason to fail or repeat the
          // write-back that already landed on the order.
          try {
            await fireCallCompletedTrigger(client, {
              orderId,
              outcome: plan.metafields['cod_status'] ?? '',
              confidence: Number(plan.metafields['confidence'] ?? 0),
              attempts: Number(plan.metafields['attempts'] ?? 0),
              needsReview: plan.needsReview || plan.tags.includes('naaradh:cancel-review'),
            });
          } catch (error) {
            deps.onFlowTriggerError?.(error);
          }
        }
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
