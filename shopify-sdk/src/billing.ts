import { ShopifyRequestError, type AdminClient } from './admin-client.js';
import { ShopifyUserError } from './orders.js';

/**
 * Shopify Billing API (P2-SHOP-3, ADR-0008). Mandatory for App Store merchants: a recurring
 * platform fee plus a capped usage line; overage is posted as usage records, idempotent by
 * key (Shopify returns the original record when a key is reused). Charges are made in the
 * merchant's billing currency (`shopBillingPreferences`) when Shopify supports it for them.
 *
 * Money crosses this boundary as integer minor units; Shopify wants decimal strings.
 */

export interface Money {
  readonly minor: number;
  readonly currency: string;
}

export function toMoneyInput(m: Money): { amount: string; currencyCode: string } {
  if (!Number.isSafeInteger(m.minor) || m.minor < 0)
    throw new ShopifyRequestError('money must be a non-negative integer of minor units');
  return { amount: (m.minor / 100).toFixed(2), currencyCode: m.currency };
}

export function fromMoneyV2(
  m: { amount: string | number; currencyCode: string } | null | undefined,
): Money | null {
  if (m === null || m === undefined) return null;
  return { minor: Math.round(Number(m.amount) * 100), currency: m.currencyCode };
}

type UserErrors = { field: string[] | null; message: string }[];

const BILLING_PREFERENCES = /* GraphQL */ `
  query NaaradhBillingPreferences {
    shopBillingPreferences {
      currency
    }
  }
`;

const SUBSCRIPTION_CREATE = /* GraphQL */ `
  mutation NaaradhSubscriptionCreate(
    $name: String!
    $lineItems: [AppSubscriptionLineItemInput!]!
    $returnUrl: URL!
    $test: Boolean
    $trialDays: Int
  ) {
    appSubscriptionCreate(
      name: $name
      lineItems: $lineItems
      returnUrl: $returnUrl
      test: $test
      trialDays: $trialDays
    ) {
      appSubscription {
        id
        status
        lineItems {
          id
          plan {
            pricingDetails {
              __typename
            }
          }
        }
      }
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

const SUBSCRIPTION_FETCH = /* GraphQL */ `
  query NaaradhSubscription($id: ID!) {
    node(id: $id) {
      ... on AppSubscription {
        id
        name
        status
        test
        currentPeriodEnd
        lineItems {
          id
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing {
                price {
                  amount
                  currencyCode
                }
              }
              ... on AppUsagePricing {
                balanceUsed {
                  amount
                  currencyCode
                }
                cappedAmount {
                  amount
                  currencyCode
                }
                terms
              }
            }
          }
        }
      }
    }
  }
`;

const USAGE_RECORD_CREATE = /* GraphQL */ `
  mutation NaaradhUsageRecordCreate(
    $subscriptionLineItemId: ID!
    $price: MoneyInput!
    $description: String!
    $idempotencyKey: String
  ) {
    appUsageRecordCreate(
      subscriptionLineItemId: $subscriptionLineItemId
      price: $price
      description: $description
      idempotencyKey: $idempotencyKey
    ) {
      appUsageRecord {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CAP_UPDATE = /* GraphQL */ `
  mutation NaaradhCapUpdate($id: ID!, $cappedAmount: MoneyInput!) {
    appSubscriptionLineItemUpdate(id: $id, cappedAmount: $cappedAmount) {
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

const SUBSCRIPTION_CANCEL = /* GraphQL */ `
  mutation NaaradhSubscriptionCancel($id: ID!, $prorate: Boolean) {
    appSubscriptionCancel(id: $id, prorate: $prorate) {
      appSubscription {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export type ShopifySubscriptionStatus =
  | 'ACTIVE'
  | 'CANCELLED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'FROZEN'
  | 'PENDING'
  | 'ACCEPTED';

export interface ShopifySubscription {
  readonly id: string;
  readonly status: ShopifySubscriptionStatus;
  readonly test: boolean;
  readonly currentPeriodEnd: Date | null;
  readonly recurringLineItemId: string | null;
  readonly recurring: Money | null;
  readonly usageLineItemId: string | null;
  readonly balanceUsed: Money | null;
  readonly cappedAmount: Money | null;
}

export async function billingCurrency(client: AdminClient): Promise<string> {
  const data = await client.request<{ shopBillingPreferences: { currency: string } | null }>(
    BILLING_PREFERENCES,
  );
  return data.shopBillingPreferences?.currency ?? 'USD';
}

export interface CreateSubscriptionInput {
  readonly name: string;
  readonly returnUrl: string;
  readonly recurring: Money;
  /** The merchant's spend cap for usage in one 30-day interval. */
  readonly cappedAmount: Money;
  readonly terms: string;
  readonly test: boolean;
  readonly trialDays?: number;
}

export async function createSubscription(
  client: AdminClient,
  input: CreateSubscriptionInput,
): Promise<{ subscriptionId: string; usageLineItemId: string | null; confirmationUrl: string }> {
  const data = await client.request<{
    appSubscriptionCreate: {
      appSubscription: {
        id: string;
        lineItems: { id: string; plan: { pricingDetails: { __typename: string } } }[];
      } | null;
      confirmationUrl: string | null;
      userErrors: UserErrors;
    } | null;
  }>(SUBSCRIPTION_CREATE, {
    name: input.name.slice(0, 255),
    returnUrl: input.returnUrl,
    test: input.test,
    ...(input.trialDays === undefined ? {} : { trialDays: input.trialDays }),
    lineItems: [
      {
        plan: {
          appRecurringPricingDetails: {
            price: toMoneyInput(input.recurring),
            interval: 'EVERY_30_DAYS',
          },
        },
      },
      {
        plan: {
          appUsagePricingDetails: {
            cappedAmount: toMoneyInput(input.cappedAmount),
            terms: input.terms.slice(0, 500),
          },
        },
      },
    ],
  });
  const payload = data.appSubscriptionCreate;
  const errors = payload?.userErrors ?? [];
  if (errors.length > 0) throw new ShopifyUserError('appSubscriptionCreate', errors);
  if (
    payload?.appSubscription === null ||
    payload?.appSubscription === undefined ||
    payload.confirmationUrl === null
  )
    throw new ShopifyRequestError('appSubscriptionCreate returned no subscription');
  const usage = payload.appSubscription.lineItems.find(
    (l) => l.plan.pricingDetails.__typename === 'AppUsagePricing',
  );
  return {
    subscriptionId: payload.appSubscription.id,
    usageLineItemId: usage?.id ?? null,
    confirmationUrl: payload.confirmationUrl,
  };
}

type PricingDetails =
  | { __typename: 'AppRecurringPricing'; price: { amount: string; currencyCode: string } }
  | {
      __typename: 'AppUsagePricing';
      balanceUsed: { amount: string; currencyCode: string };
      cappedAmount: { amount: string; currencyCode: string };
    };

/** The source of truth for a subscription's state — webhooks only tell us to look (ADR-0008). */
export async function fetchSubscription(
  client: AdminClient,
  id: string,
): Promise<ShopifySubscription | null> {
  const data = await client.request<{
    node: {
      id: string;
      status: ShopifySubscriptionStatus;
      test: boolean;
      currentPeriodEnd: string | null;
      lineItems: { id: string; plan: { pricingDetails: PricingDetails } }[];
    } | null;
  }>(SUBSCRIPTION_FETCH, { id });
  const n = data.node;
  if (n === null || typeof n.status !== 'string') return null;
  const recurring = n.lineItems.find(
    (l) => l.plan.pricingDetails.__typename === 'AppRecurringPricing',
  );
  const usage = n.lineItems.find((l) => l.plan.pricingDetails.__typename === 'AppUsagePricing');
  const usagePricing =
    usage?.plan.pricingDetails.__typename === 'AppUsagePricing' ? usage.plan.pricingDetails : null;
  const recurringPricing =
    recurring?.plan.pricingDetails.__typename === 'AppRecurringPricing'
      ? recurring.plan.pricingDetails
      : null;
  return {
    id: n.id,
    status: n.status,
    test: n.test,
    currentPeriodEnd: n.currentPeriodEnd === null ? null : new Date(n.currentPeriodEnd),
    recurringLineItemId: recurring?.id ?? null,
    recurring: fromMoneyV2(recurringPricing?.price),
    usageLineItemId: usage?.id ?? null,
    balanceUsed: fromMoneyV2(usagePricing?.balanceUsed),
    cappedAmount: fromMoneyV2(usagePricing?.cappedAmount),
  };
}

export async function createUsageRecord(
  client: AdminClient,
  input: {
    readonly lineItemId: string;
    readonly price: Money;
    readonly description: string;
    readonly idempotencyKey: string;
  },
): Promise<string> {
  if (input.idempotencyKey.length > 255)
    throw new ShopifyRequestError('idempotency key over 255 characters');
  const data = await client.request<{
    appUsageRecordCreate: { appUsageRecord: { id: string } | null; userErrors: UserErrors } | null;
  }>(USAGE_RECORD_CREATE, {
    subscriptionLineItemId: input.lineItemId,
    price: toMoneyInput(input.price),
    description: input.description.slice(0, 255),
    idempotencyKey: input.idempotencyKey,
  });
  const errors = data.appUsageRecordCreate?.userErrors ?? [];
  const record = data.appUsageRecordCreate?.appUsageRecord ?? null;
  if (errors.length > 0 || record === null)
    throw new ShopifyUserError(
      'appUsageRecordCreate',
      errors.length > 0 ? errors : [{ field: null, message: 'no usage record returned' }],
    );
  return record.id;
}

/** Raising the cap needs the merchant's approval at the returned URL (E-61). */
export async function requestCapChange(
  client: AdminClient,
  lineItemId: string,
  cappedAmount: Money,
): Promise<string> {
  const data = await client.request<{
    appSubscriptionLineItemUpdate: {
      confirmationUrl: string | null;
      userErrors: UserErrors;
    } | null;
  }>(CAP_UPDATE, { id: lineItemId, cappedAmount: toMoneyInput(cappedAmount) });
  const errors = data.appSubscriptionLineItemUpdate?.userErrors ?? [];
  const url = data.appSubscriptionLineItemUpdate?.confirmationUrl ?? null;
  if (errors.length > 0 || url === null)
    throw new ShopifyUserError(
      'appSubscriptionLineItemUpdate',
      errors.length > 0 ? errors : [{ field: null, message: 'no confirmation url' }],
    );
  return url;
}

export async function cancelSubscription(client: AdminClient, id: string): Promise<void> {
  const data = await client.request<{ appSubscriptionCancel: { userErrors: UserErrors } | null }>(
    SUBSCRIPTION_CANCEL,
    { id, prorate: false },
  );
  const errors = data.appSubscriptionCancel?.userErrors ?? [];
  if (errors.length > 0) throw new ShopifyUserError('appSubscriptionCancel', errors);
}
