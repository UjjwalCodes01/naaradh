import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe Billing (P6-BILL-1, ADR-0008) for direct merchants outside India who pay in dollars.
 * Shopify stores are still billed only through Shopify; Indian merchants through Razorpay.
 *
 * A tenant subscribes through Stripe Checkout (`mode=subscription`, one line item per plan
 * price, created once in the Stripe dashboard and referenced by id — `STRIPE_PRICE_IDS`).
 * Usage beyond the plans' allowances is an invoice item on the customer, attached to the
 * subscription so it lands on the next invoice — one per tenant per closed period, like the
 * Razorpay add-on. Amounts are integer minor units (cents).
 *
 * HTTP over fetch, form-encoded as Stripe's API expects; no SDK. The API version is pinned so a
 * dashboard upgrade cannot change a response shape under us. Every write carries an
 * Idempotency-Key.
 */

export const STRIPE_API_VERSION = '2024-06-20';

export class StripeRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeRetryableError';
  }
}

export class StripeError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(`Stripe ${String(status)}${code === null ? '' : ` ${code}`}: ${message.slice(0, 300)}`);
    this.name = 'StripeError';
    this.status = status;
    this.code = code;
  }
}

export type StripeSubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused';

export interface StripeCheckoutSession {
  readonly id: string;
  readonly url: string | null;
  /** 'open' | 'complete' | 'expired' — kept as a string so a new Stripe value never fails a parse. */
  readonly status: string;
  readonly subscriptionId: string | null;
  readonly customerId: string | null;
  readonly tenantId: string | null;
}

export interface StripeSubscription {
  readonly id: string;
  readonly status: StripeSubscriptionStatus;
  readonly customerId: string;
  readonly currentPeriodEnd: Date | null;
  readonly currency: string;
  readonly tenantId: string | null;
}

export interface StripeClient {
  createCheckoutSession(input: {
    readonly priceIds: readonly string[];
    readonly tenantId: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
    readonly customerEmail?: string;
    readonly idempotencyKey: string;
  }): Promise<StripeCheckoutSession>;
  retrieveCheckoutSession(id: string): Promise<StripeCheckoutSession>;
  retrieveSubscription(id: string): Promise<StripeSubscription>;
  createInvoiceItem(input: {
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly description: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly id: string }>;
  cancelSubscription(id: string, atPeriodEnd: boolean): Promise<StripeSubscription>;
}

interface WireSession {
  id: string;
  url?: string | null;
  status?: string | null;
  subscription?: string | { id: string } | null;
  customer?: string | { id: string } | null;
  client_reference_id?: string | null;
}

interface WireSubscription {
  id: string;
  status: StripeSubscriptionStatus;
  customer: string | { id: string };
  current_period_end?: number | null;
  currency?: string | null;
  metadata?: Record<string, string> | null;
  items?: { data?: { current_period_end?: number | null }[] } | null;
}

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : v.id;

function toSession(w: WireSession): StripeCheckoutSession {
  return {
    id: w.id,
    url: w.url ?? null,
    status: w.status ?? 'open',
    subscriptionId: idOf(w.subscription),
    customerId: idOf(w.customer),
    tenantId: w.client_reference_id ?? null,
  };
}

function toSubscription(w: WireSubscription): StripeSubscription {
  // Newer API versions moved the period end onto the items; accept either.
  const end = w.current_period_end ?? w.items?.data?.[0]?.current_period_end ?? null;
  return {
    id: w.id,
    status: w.status,
    customerId: idOf(w.customer) ?? '',
    currentPeriodEnd: typeof end === 'number' ? new Date(end * 1000) : null,
    currency: (w.currency ?? 'usd').toUpperCase(),
    tenantId: w.metadata?.['tenant_id'] ?? null,
  };
}

/** Stripe's form encoding: nested keys as `a[b][0]=…`. */
export function formEncode(body: Readonly<Record<string, unknown>>): string {
  const out: string[] = [];
  const walk = (prefix: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v: unknown, i) => {
        walk(`${prefix}[${String(i)}]`, v);
      });
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        walk(prefix === '' ? k : `${prefix}[${k}]`, v);
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
    } else {
      throw new TypeError(`cannot form-encode ${typeof value} at ${prefix}`);
    }
  };
  walk('', body);
  return out.join('&');
}

const ID = {
  session: /^cs_(test|live)_[A-Za-z0-9]+$/,
  subscription: /^sub_[A-Za-z0-9]+$/,
  customer: /^cus_[A-Za-z0-9]+$/,
};

export function createStripeClient(config: {
  readonly secretKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): StripeClient {
  const base = config.baseUrl ?? 'https://api.stripe.com/v1';
  const doFetch = config.fetchImpl ?? fetch;

  const call = async <T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Readonly<Record<string, unknown>>,
    idempotencyKey?: string,
  ): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.secretKey}`,
          'stripe-version': STRIPE_API_VERSION,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        },
        ...(body === undefined ? {} : { body: formEncode(body) }),
        signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new StripeRetryableError(
        `network error calling Stripe: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
    if (res.status === 429 || res.status >= 500)
      throw new StripeRetryableError(`Stripe HTTP ${String(res.status)}`);
    const json = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    if (!res.ok)
      throw new StripeError(
        res.status,
        json?.error?.code ?? null,
        json?.error?.message ?? 'request failed',
      );
    return json as T;
  };

  const check = (id: string, re: RegExp, what: string) => {
    if (!re.test(id)) throw new StripeError(400, 'invalid_id', `invalid ${what} id`);
  };

  return {
    async createCheckoutSession(input) {
      if (input.priceIds.length === 0) throw new StripeError(400, 'no_prices', 'no plan chosen');
      const w = await call<WireSession>(
        'POST',
        '/checkout/sessions',
        {
          mode: 'subscription',
          line_items: input.priceIds.map((price) => ({ price, quantity: 1 })),
          client_reference_id: input.tenantId,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          ...(input.customerEmail === undefined ? {} : { customer_email: input.customerEmail }),
          metadata: { tenant_id: input.tenantId },
          subscription_data: { metadata: { tenant_id: input.tenantId } },
        },
        input.idempotencyKey,
      );
      return toSession(w);
    },
    async retrieveCheckoutSession(id) {
      check(id, ID.session, 'checkout session');
      return toSession(await call<WireSession>('GET', `/checkout/sessions/${id}`));
    },
    async retrieveSubscription(id) {
      check(id, ID.subscription, 'subscription');
      return toSubscription(await call<WireSubscription>('GET', `/subscriptions/${id}`));
    },
    async createInvoiceItem(input) {
      check(input.customerId, ID.customer, 'customer');
      check(input.subscriptionId, ID.subscription, 'subscription');
      if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
        throw new StripeError(400, 'bad_amount', 'amount must be a positive integer of cents');
      const w = await call<{ id: string }>(
        'POST',
        '/invoiceitems',
        {
          customer: input.customerId,
          subscription: input.subscriptionId,
          amount: input.amountMinor,
          currency: input.currency.toLowerCase(),
          description: input.description.slice(0, 500),
        },
        input.idempotencyKey,
      );
      return { id: w.id };
    },
    async cancelSubscription(id, atPeriodEnd) {
      check(id, ID.subscription, 'subscription');
      const w = atPeriodEnd
        ? await call<WireSubscription>(
            'POST',
            `/subscriptions/${id}`,
            { cancel_at_period_end: true },
            `cancel:${id}`,
          )
        : await call<WireSubscription>('DELETE', `/subscriptions/${id}`);
      return toSubscription(w);
    },
  };
}

/**
 * `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]` = HMAC-SHA256(endpoint secret, `${t}.${raw}`)
 * (invariant 9). Several v1 values appear while an endpoint secret is being rolled; any match
 * verifies. Outside the tolerance the event is a replay and is refused.
 */
export function verifyStripeSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
  nowUnix: number,
  toleranceSec = 300,
): boolean {
  if (header === undefined) return false;
  let t: number | null = null;
  const v1: Buffer[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't' && v !== undefined && /^\d+$/.test(v)) t = Number(v);
    if (k === 'v1' && v !== undefined && /^[0-9a-f]{64}$/.test(v)) v1.push(Buffer.from(v, 'hex'));
  }
  if (t === null || v1.length === 0 || Math.abs(nowUnix - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${String(t)}.`, 'utf8'), rawBody]))
    .digest();
  return v1.some((given) => given.length === expected.length && timingSafeEqual(given, expected));
}

/** Stripe's signing scheme, for tests and for replaying a captured event locally. */
export function signStripePayload(secret: string, rawBody: Buffer, unix: number): string {
  const v1 = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${String(unix)}.`, 'utf8'), rawBody]))
    .digest('hex');
  return `t=${String(unix)},v1=${v1}`;
}

export interface StripeBillingEvent {
  readonly id: string;
  readonly type: string;
  /** The subscription the event is about, when it can be told from the event. */
  readonly subscriptionId: string | null;
  /** The checkout session, for `checkout.session.*` events. */
  readonly checkoutSessionId: string | null;
}

/**
 * Parse a VERIFIED event body down to ids. The body is never stored: it can carry the payer's
 * name, email and address, and nothing downstream needs them (the worker re-fetches).
 */
export function parseStripeEvent(rawBody: Buffer): StripeBillingEvent | null {
  let body: { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } };
  try {
    body = JSON.parse(rawBody.toString('utf8')) as typeof body;
  } catch {
    return null;
  }
  if (typeof body.id !== 'string' || typeof body.type !== 'string') return null;
  const obj = body.data?.object ?? {};
  const objectType = obj['object'];
  const subscriptionId =
    objectType === 'subscription'
      ? idOf(obj['id'] as string)
      : idOf((obj['subscription'] as string | { id: string } | null | undefined) ?? null);
  return {
    id: body.id,
    type: body.type,
    subscriptionId:
      subscriptionId !== null && ID.subscription.test(subscriptionId) ? subscriptionId : null,
    checkoutSessionId:
      objectType === 'checkout.session' && typeof obj['id'] === 'string' ? obj['id'] : null,
  };
}
