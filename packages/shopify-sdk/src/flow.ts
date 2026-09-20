import type { AdminClient } from './admin-client.js';
import { ShopifyUserError } from './orders.js';

/**
 * Shopify Flow trigger "Naaradh call completed" (P2-SHOP-7) — the extension in
 * apps/shopify/extensions/call-completed-flow-trigger. The payload's keys are the extension's
 * field keys; an `order_reference` field is addressed as `order_id` (the numeric id).
 * [VERIFY] against the Flow trigger reference when the extension is first deployed.
 */
export const FLOW_TRIGGER_HANDLE = 'naaradh-call-completed';

const FLOW_TRIGGER = /* GraphQL */ `
  mutation NaaradhFlowTrigger($handle: String!, $payload: JSON!) {
    flowTriggerReceive(handle: $handle, payload: $payload) {
      userErrors {
        field
        message
      }
    }
  }
`;

export interface CallCompletedTrigger {
  readonly orderId: string;
  readonly outcome: string;
  readonly confidence: number;
  readonly attempts: number;
  readonly needsReview: boolean;
}

export async function fireCallCompletedTrigger(
  client: AdminClient,
  input: CallCompletedTrigger,
): Promise<void> {
  if (!/^\d+$/.test(input.orderId)) return; // not a Shopify order id: nothing to reference
  const data = await client.request<{
    flowTriggerReceive: { userErrors: { field: string[] | null; message: string }[] } | null;
  }>(FLOW_TRIGGER, {
    handle: FLOW_TRIGGER_HANDLE,
    payload: {
      order_id: Number(input.orderId),
      outcome: input.outcome,
      confidence: Math.round(input.confidence * 100) / 100,
      attempts: input.attempts,
      needs_review: input.needsReview,
    },
  });
  const errors = data.flowTriggerReceive?.userErrors ?? [];
  if (errors.length > 0) throw new ShopifyUserError('flowTriggerReceive', errors);
}
