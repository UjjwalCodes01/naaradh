import { ShopifyRequestError, type AdminClient } from './admin-client.js';

/**
 * Order write-back operations (P1-SHOP-2) against the Admin GraphQL API. Shapes follow
 * shopify.dev's reference for `tagsAdd`, `orderUpdate`, `metafieldsSet`, `orderCancel`
 * (2024-01+). Each is idempotent so a retried write-back converges instead of duplicating:
 *
 *   tagsAdd         adding an existing tag is a no-op
 *   orderUpdate     note is SET (the latest call's line), not appended
 *   metafieldsSet   upsert by (owner, namespace, key)
 *   orderCancel     guarded by a read of `cancelledAt` — an already-cancelled order is success
 *
 * Addresses are deliberately absent: an agent never writes one (invariant 14) and a
 * free-text address from an extraction cannot be mapped safely onto structured shipping
 * fields (Q-19). They reach the merchant as a review tag and in the dashboard.
 */

export const METAFIELD_NAMESPACE = 'naaradh';

export class ShopifyUserError extends Error {
  readonly operation: string;
  readonly userErrors: readonly {
    field: readonly string[] | null;
    message: string;
    code?: string | null;
  }[];
  constructor(operation: string, userErrors: ShopifyUserError['userErrors']) {
    super(
      `${operation}: ${userErrors
        .map((e) => e.message)
        .join('; ')
        .slice(0, 300)}`,
    );
    this.name = 'ShopifyUserError';
    this.operation = operation;
    this.userErrors = userErrors;
  }
}

/** Numeric REST id (webhooks, our order cache) → Admin GraphQL GID. */
export function toOrderGid(externalId: string): string {
  if (externalId.startsWith('gid://shopify/Order/')) return externalId;
  if (!/^\d{1,20}$/.test(externalId)) throw new ShopifyRequestError('not a Shopify order id');
  return `gid://shopify/Order/${externalId}`;
}

type UserErrors = { field: string[] | null; message: string; code?: string | null }[];

const TAGS_ADD = /* GraphQL */ `
  mutation NaaradhTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_NOTE = /* GraphQL */ `
  mutation NaaradhOrderNote($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const METAFIELDS_SET = /* GraphQL */ `
  mutation NaaradhMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
        namespace
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const ORDER_STATE = /* GraphQL */ `
  query NaaradhOrderState($id: ID!) {
    order(id: $id) {
      id
      cancelledAt
    }
  }
`;

const ORDER_CANCEL = /* GraphQL */ `
  mutation NaaradhOrderCancel(
    $orderId: ID!
    $reason: OrderCancelReason!
    $restock: Boolean!
    $notifyCustomer: Boolean
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      reason: $reason
      restock: $restock
      notifyCustomer: $notifyCustomer
      staffNote: $staffNote
    ) {
      job {
        id
        done
      }
      orderCancelUserErrors {
        field
        message
        code
      }
    }
  }
`;

export async function addOrderTags(
  client: AdminClient,
  orderId: string,
  tags: readonly string[],
): Promise<void> {
  const clean = [
    ...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 40)),
  ];
  if (clean.length === 0) return;
  const data = await client.request<{ tagsAdd: { userErrors: UserErrors } | null }>(TAGS_ADD, {
    id: toOrderGid(orderId),
    tags: clean,
  });
  const errors = data.tagsAdd?.userErrors ?? [];
  if (errors.length > 0) throw new ShopifyUserError('tagsAdd', errors);
}

export async function setOrderNote(
  client: AdminClient,
  orderId: string,
  note: string,
): Promise<void> {
  const data = await client.request<{ orderUpdate: { userErrors: UserErrors } | null }>(
    ORDER_NOTE,
    {
      input: { id: toOrderGid(orderId), note: note.slice(0, 5000) },
    },
  );
  const errors = data.orderUpdate?.userErrors ?? [];
  if (errors.length > 0) throw new ShopifyUserError('orderUpdate', errors);
}

export async function setOrderMetafields(
  client: AdminClient,
  orderId: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const ownerId = toOrderGid(orderId);
  const metafields = Object.entries(values)
    .filter(([key, value]) => /^[a-z0-9_]{1,64}$/.test(key) && value.length > 0)
    .map(([key, value]) => ({
      ownerId,
      namespace: METAFIELD_NAMESPACE,
      key,
      type: 'single_line_text_field',
      value: value.slice(0, 255),
    }));
  if (metafields.length === 0) return;
  const data = await client.request<{ metafieldsSet: { userErrors: UserErrors } | null }>(
    METAFIELDS_SET,
    { metafields },
  );
  const errors = data.metafieldsSet?.userErrors ?? [];
  if (errors.length > 0) throw new ShopifyUserError('metafieldsSet', errors);
}

export type CancelResult =
  | { readonly kind: 'already_cancelled' }
  /** Shopify cancels in a background job; `done` false means accepted, not yet finished. */
  | { readonly kind: 'submitted'; readonly jobId: string | null; readonly done: boolean };

export interface CancelOptions {
  readonly staffNote: string;
  /** Put unshipped stock back (default true — these orders never left the warehouse). */
  readonly restock?: boolean;
  /** Shopify's cancellation email — the agent told the caller the store would confirm. */
  readonly notifyCustomer?: boolean;
}

/**
 * Cancel a COD order at the customer's request. No refund is requested: COD orders taken
 * through this path are unpaid (the caller-side policy refuses prepaid ones, E-85). If the
 * order is found to have shipped or been paid by the time we get here, that is the caller's
 * guard to re-check — this function refuses only what Shopify refuses.
 */
export async function cancelOrder(
  client: AdminClient,
  orderId: string,
  options: CancelOptions,
): Promise<CancelResult> {
  const id = toOrderGid(orderId);
  const state = await client.request<{ order: { cancelledAt: string | null } | null }>(
    ORDER_STATE,
    { id },
  );
  if (state.order === null)
    throw new ShopifyUserError('orderCancel', [{ field: ['orderId'], message: 'order not found' }]);
  if (state.order.cancelledAt !== null) return { kind: 'already_cancelled' };

  const data = await client.request<{
    orderCancel: {
      job: { id: string; done: boolean } | null;
      orderCancelUserErrors: UserErrors;
    } | null;
  }>(ORDER_CANCEL, {
    orderId: id,
    reason: 'CUSTOMER',
    restock: options.restock ?? true,
    notifyCustomer: options.notifyCustomer ?? true,
    staffNote: options.staffNote.slice(0, 255),
  });
  const errors = data.orderCancel?.orderCancelUserErrors ?? [];
  if (errors.length > 0) throw new ShopifyUserError('orderCancel', errors);
  return {
    kind: 'submitted',
    jobId: data.orderCancel?.job?.id ?? null,
    done: data.orderCancel?.job?.done ?? false,
  };
}

export interface OrderWriteback {
  readonly tags: readonly string[];
  readonly note: string;
  readonly metafields: Readonly<Record<string, string>>;
  readonly cancelOrder: boolean;
}

/**
 * Non-destructive writes first (tags, note, metafields), the cancel last — so the audit trail
 * lands on the order even when the cancel is refused, and a retry re-runs the idempotent part
 * then finds the order already cancelled.
 */
export async function applyOrderWriteback(
  client: AdminClient,
  orderId: string,
  plan: OrderWriteback,
): Promise<{ cancel: CancelResult | null }> {
  await addOrderTags(client, orderId, plan.tags);
  if (plan.note.length > 0) await setOrderNote(client, orderId, plan.note);
  await setOrderMetafields(client, orderId, plan.metafields);
  const cancel = plan.cancelOrder
    ? await cancelOrder(client, orderId, { staffNote: plan.note })
    : null;
  return { cancel };
}
