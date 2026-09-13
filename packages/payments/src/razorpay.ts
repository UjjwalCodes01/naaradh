import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay Subscriptions (P2-BILL-3, ADR-0008) for direct Indian merchants — GST invoices,
 * UPI/cards/net-banking. Plans are created once in the Razorpay dashboard and referenced by id
 * (`RAZORPAY_PLAN_IDS`); a tenant subscribes through the returned `short_url`. Usage beyond the
 * plan's allowance is added as an add-on, charged on the next invoice. Amounts are paise.
 *
 * Endpoints follow Razorpay's API (and razorpay-node's source for `/subscriptions/{id}/addons`);
 * auth is HTTP Basic with key id + secret.
 */

export class RazorpayRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RazorpayRetryableError';
  }
}

export class RazorpayError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, description: string) {
    super(
      `Razorpay ${String(status)}${code === null ? '' : ` ${code}`}: ${description.slice(0, 300)}`,
    );
    this.name = 'RazorpayError';
    this.status = status;
    this.code = code;
  }
}

export type RazorpaySubscriptionStatus =
  | 'created'
  | 'authenticated'
  | 'active'
  | 'pending'
  | 'halted'
  | 'cancelled'
  | 'completed'
  | 'expired'
  | 'paused';

export interface RazorpaySubscription {
  readonly id: string;
  readonly planId: string;
  readonly status: RazorpaySubscriptionStatus;
  readonly shortUrl: string | null;
  readonly currentEnd: Date | null;
  readonly notes: Readonly<Record<string, string>>;
}

export interface RazorpayClient {
  createSubscription(input: {
    readonly planId: string;
    /** Billing cycles before it ends; 120 monthly cycles ≈ 10 years, i.e. "until cancelled". */
    readonly totalCount?: number;
    readonly notes: Readonly<Record<string, string>>;
  }): Promise<RazorpaySubscription>;
  fetchSubscription(id: string): Promise<RazorpaySubscription>;
  createAddon(
    subscriptionId: string,
    input: {
      readonly name: string;
      readonly amountMinor: number;
      readonly currency: 'INR';
      readonly description?: string;
    },
  ): Promise<{ readonly id: string }>;
  cancelSubscription(id: string, atCycleEnd: boolean): Promise<RazorpaySubscription>;
}

interface WireSubscription {
  id: string;
  plan_id: string;
  status: RazorpaySubscriptionStatus;
  short_url?: string | null;
  current_end?: number | null;
  notes?: Record<string, string> | unknown[] | null;
}

function toSubscription(w: WireSubscription): RazorpaySubscription {
  return {
    id: w.id,
    planId: w.plan_id,
    status: w.status,
    shortUrl: w.short_url ?? null,
    currentEnd: typeof w.current_end === 'number' ? new Date(w.current_end * 1000) : null,
    // Razorpay returns [] for empty notes.
    notes: w.notes !== null && w.notes !== undefined && !Array.isArray(w.notes) ? w.notes : {},
  };
}

export function createRazorpayClient(config: {
  readonly keyId: string;
  readonly keySecret: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): RazorpayClient {
  const base = config.baseUrl ?? 'https://api.razorpay.com/v1';
  const doFetch = config.fetchImpl ?? fetch;
  const auth = `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`;

  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: auth,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new RazorpayRetryableError(
        `network error calling Razorpay: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
    if (res.status === 429 || res.status >= 500)
      throw new RazorpayRetryableError(`Razorpay HTTP ${String(res.status)}`);
    const json = (await res.json().catch(() => null)) as {
      error?: { code?: string; description?: string };
    } | null;
    if (!res.ok)
      throw new RazorpayError(
        res.status,
        json?.error?.code ?? null,
        json?.error?.description ?? 'request failed',
      );
    return json as T;
  };

  return {
    async createSubscription(input) {
      const w = await call<WireSubscription>('POST', '/subscriptions', {
        plan_id: input.planId,
        total_count: input.totalCount ?? 120,
        customer_notify: 1,
        notes: input.notes,
      });
      return toSubscription(w);
    },
    async fetchSubscription(id) {
      if (!/^sub_[A-Za-z0-9]+$/.test(id))
        throw new RazorpayError(400, 'BAD_REQUEST_ERROR', 'invalid subscription id');
      return toSubscription(await call<WireSubscription>('GET', `/subscriptions/${id}`));
    },
    async createAddon(subscriptionId, input) {
      if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId))
        throw new RazorpayError(400, 'BAD_REQUEST_ERROR', 'invalid subscription id');
      if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
        throw new RazorpayError(
          400,
          'BAD_REQUEST_ERROR',
          'add-on amount must be a positive integer of paise',
        );
      const w = await call<{ id: string }>('POST', `/subscriptions/${subscriptionId}/addons`, {
        item: {
          name: input.name.slice(0, 100),
          amount: input.amountMinor,
          currency: input.currency,
          ...(input.description === undefined
            ? {}
            : { description: input.description.slice(0, 250) }),
        },
        quantity: 1,
      });
      return { id: w.id };
    },
    async cancelSubscription(id, atCycleEnd) {
      if (!/^sub_[A-Za-z0-9]+$/.test(id))
        throw new RazorpayError(400, 'BAD_REQUEST_ERROR', 'invalid subscription id');
      return toSubscription(
        await call<WireSubscription>(
          'POST',
          `/subscriptions/${id}/cancel`,
          atCycleEnd ? { cancel_at_cycle_end: 1 } : {},
        ),
      );
    },
  };
}

/** `X-Razorpay-Signature` = hex HMAC-SHA256 of the RAW body with the webhook secret (invariant 9). */
export function verifyRazorpaySignature(
  secret: string,
  rawBody: Buffer,
  signature: string | undefined,
): boolean {
  if (signature === undefined || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface RazorpaySubscriptionEvent {
  readonly event: string;
  readonly subscriptionId: string;
  readonly status: RazorpaySubscriptionStatus;
  readonly tenantId: string | null;
}

/** Parse a VERIFIED subscription webhook body; null for events that are not about a subscription. */
export function parseRazorpaySubscriptionEvent(rawBody: Buffer): RazorpaySubscriptionEvent | null {
  let body: { event?: unknown; payload?: { subscription?: { entity?: WireSubscription } } };
  try {
    body = JSON.parse(rawBody.toString('utf8')) as typeof body;
  } catch {
    return null;
  }
  const entity = body.payload?.subscription?.entity;
  if (
    typeof body.event !== 'string' ||
    !body.event.startsWith('subscription.') ||
    entity === undefined ||
    typeof entity.id !== 'string'
  )
    return null;
  const notes =
    entity.notes !== null && entity.notes !== undefined && !Array.isArray(entity.notes)
      ? entity.notes
      : {};
  return {
    event: body.event,
    subscriptionId: entity.id,
    status: entity.status,
    tenantId: typeof notes['tenant_id'] === 'string' ? notes['tenant_id'] : null,
  };
}
