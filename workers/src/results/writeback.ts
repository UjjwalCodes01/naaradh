import { AUTO_WRITE_CONFIDENCE_MIN } from '@naaradh/compliance';

/**
 * Shopify order write-back (SPEC §8.5, AGENTS §5.4, P1-SHOP-2). The PLAN is pure and tested;
 * the PORT executes it (`shopify-writeback.ts` in production, `recordingWriteback()` in dev/test).
 *
 * Invariant 14: an order is cancelled from an extraction only when the tenant switched
 * auto-cancel on AND confidence ≥ 0.9; otherwise `naaradh:cancel-review`.
 *
 * Addresses are NEVER written to Shopify, whatever the tenant setting (Q-19): the extraction
 * is free text ("flat 2, near the temple, new road") and Shopify's shipping address is
 * structured — there is no safe mapping, and a wrong one ships a parcel to the wrong place.
 * An address change is always `naaradh:address-review` + writeback_status = needs_review,
 * and the suggested text stays in the dashboard (E-44). `address_write_enabled` is kept for
 * when Q-19 closes with a structured-address design.
 */
export interface WritebackInput {
  readonly outcome: string;
  readonly confidence: number;
  readonly attempts: number;
  readonly outcomeId: string;
  readonly lastCallAt: Date;
  readonly summary: string;
  readonly addressChange: string | null;
  readonly tenant: { autoCancelEnabled: boolean; addressWriteEnabled: boolean };
}

export interface WritebackPlan {
  readonly tags: string[];
  readonly note: string;
  readonly metafields: Record<string, string>;
  readonly cancelOrder: boolean;
  readonly needsReview: boolean;
}

const TAG_BY_OUTCOME: Readonly<Record<string, string>> = {
  confirmed: 'naaradh:cod-confirmed',
  confirmed_with_changes: 'naaradh:cod-confirmed',
  cancelled: 'naaradh:cod-cancelled',
  rescheduled: 'naaradh:cod-reschedule',
  no_answer: 'naaradh:no-answer',
  busy: 'naaradh:no-answer',
  voicemail: 'naaradh:no-answer',
  wrong_number: 'naaradh:wrong-number',
  opt_out: 'naaradh:opt-out',
  transferred: 'naaradh:transfer-requested',
  callback_requested: 'naaradh:callback-requested',
  needs_merchant_action: 'naaradh:needs-action',
  convert_to_prepaid_requested: 'naaradh:prepaid-requested',
  inconclusive: 'naaradh:inconclusive',
  outcome_superseded: 'naaradh:superseded',
};

export function planWriteback(input: WritebackInput): WritebackPlan {
  const tags = [TAG_BY_OUTCOME[input.outcome] ?? `naaradh:${input.outcome}`];
  if (input.outcome === 'no_answer' || input.outcome === 'busy' || input.outcome === 'voicemail')
    tags.push(`naaradh:no-answer-${String(input.attempts)}`);

  const highConfidence = input.confidence >= AUTO_WRITE_CONFIDENCE_MIN;
  const cancelOrder =
    input.outcome === 'cancelled' && input.tenant.autoCancelEnabled && highConfidence;
  const needsReview = input.addressChange !== null && input.addressChange.trim().length > 0;
  if (needsReview) tags.push('naaradh:address-review');
  if (input.outcome === 'cancelled' && !cancelOrder) tags.push('naaradh:cancel-review');

  const note = `Naaradh · ${input.lastCallAt.toISOString()} · ${input.outcome} · ${input.summary.slice(0, 200)} · recording in app`;
  return {
    tags,
    note,
    metafields: {
      cod_status: input.outcome,
      last_call_at: input.lastCallAt.toISOString(),
      attempts: String(input.attempts),
      confidence: input.confidence.toFixed(2),
      outcome_ref: input.outcomeId,
    },
    cancelOrder,
    needsReview,
  };
}

export interface ShopifyWriteback {
  /**
   * Executes the plan against every order ref (numeric Shopify order ids). Throws on failure;
   * `isRetryableWritebackError()` says whether trying again later can help.
   */
  apply(
    tenantId: string,
    store: { readonly shopDomain: string; readonly credentialsSecretRef: string | null },
    orderIds: readonly string[],
    plan: WritebackPlan,
  ): Promise<void>;
}

/** Records what would have been written — dev, CI and tests never call a real store. */
export function recordingWriteback(): ShopifyWriteback & {
  applied: {
    tenantId: string;
    shopDomain: string;
    orderIds: readonly string[];
    plan: WritebackPlan;
  }[];
  failNext: number;
} {
  const store = {
    applied: [] as {
      tenantId: string;
      shopDomain: string;
      orderIds: readonly string[];
      plan: WritebackPlan;
    }[],
    failNext: 0,
    async apply(
      tenantId: string,
      target: { readonly shopDomain: string; readonly credentialsSecretRef: string | null },
      orderIds: readonly string[],
      plan: WritebackPlan,
    ): Promise<void> {
      if (store.failNext > 0) {
        store.failNext -= 1;
        throw new Error('simulated Shopify failure');
      }
      store.applied.push({ tenantId, shopDomain: target.shopDomain, orderIds, plan });
    },
  };
  return store;
}
