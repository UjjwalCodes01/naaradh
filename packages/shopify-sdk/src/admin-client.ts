/**
 * Minimal Shopify Admin GraphQL client (P1-SHOP-2). No SDK: one POST per request, the
 * access token in `X-Shopify-Access-Token`, the API version pinned by the caller.
 *
 * Failure classes, because callers treat them differently:
 *
 *   ShopifyRetryableError   429 / THROTTLED cost limit / 5xx / network — try again later
 *   ShopifyAuthError        401 / 403 — token revoked or scope missing; retrying will not help
 *   ShopifyRequestError     top-level GraphQL `errors` that are not throttling — a bug in the
 *                           query or a field this API version does not have; loud, not retried
 *
 * Mutation `userErrors` are NOT thrown here — they are business results (e.g. "order cannot be
 * cancelled") that the caller interprets. Transient failures are retried in-process a few
 * times with short backoff so a blip does not fail a write-back; anything longer surfaces to
 * the caller's own retry (the actions worker backs off in minutes).
 *
 * Nothing sent through this client carries a phone number: order GIDs, tags, notes and
 * metafields built from already-scrubbed plans only (invariant 8).
 */

export interface AdminClientConfig {
  /** `client-a.myshopify.com` — validated, never a full URL from untrusted input. */
  readonly shop: string;
  readonly accessToken: string;
  /** e.g. `2026-07`. */
  readonly apiVersion: string;
  readonly fetchImpl?: typeof fetch;
  /** In-process attempts for retryable failures (default 3). */
  readonly maxAttempts?: number;
  /** Longest single wait between attempts (default 5 s) — past that, give up and let the caller retry. */
  readonly maxBackoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
}

export class ShopifyRetryableError extends Error {
  readonly retryAfterSec: number | null;
  constructor(message: string, retryAfterSec: number | null = null) {
    super(message);
    this.name = 'ShopifyRetryableError';
    this.retryAfterSec = retryAfterSec;
  }
}

export class ShopifyAuthError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      `Shopify rejected the access token (HTTP ${String(status)}) — reconnect the store or check scopes`,
    );
    this.name = 'ShopifyAuthError';
    this.status = status;
  }
}

export class ShopifyRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopifyRequestError';
  }
}

export interface AdminClient {
  request<T>(query: string, variables?: Readonly<Record<string, unknown>>): Promise<T>;
}

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const API_VERSION = /^\d{4}-\d{2}$|^unstable$/;

interface GraphQLError {
  readonly message?: string;
  readonly extensions?: { readonly code?: string; readonly cost?: unknown };
}

interface GraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: readonly GraphQLError[];
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isThrottle(errors: readonly GraphQLError[]): boolean {
  return errors.some((e) =>
    `${e.extensions?.code ?? ''} ${e.message ?? ''}`.toLowerCase().includes('throttl'),
  );
}

export function createAdminClient(config: AdminClientConfig): AdminClient {
  if (!SHOP_DOMAIN.test(config.shop)) throw new ShopifyRequestError('invalid shop domain');
  if (!API_VERSION.test(config.apiVersion))
    throw new ShopifyRequestError('invalid Shopify API version');
  if (config.accessToken.length === 0) throw new ShopifyAuthError(401);
  const url = `https://${config.shop}/admin/api/${config.apiVersion}/graphql.json`;
  const doFetch = config.fetchImpl ?? fetch;
  const maxAttempts = config.maxAttempts ?? 3;
  const maxBackoffMs = config.maxBackoffMs ?? 5_000;
  const sleep = config.sleep ?? defaultSleep;
  const timeoutMs = config.timeoutMs ?? 10_000;

  const once = async <T>(
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-shopify-access-token': config.accessToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ShopifyRetryableError(
        `network error calling Shopify: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      throw new ShopifyRetryableError(
        'Shopify rate limited (429)',
        Number.isFinite(after) && after > 0 ? after : null,
      );
    }
    if (res.status === 401 || res.status === 403) throw new ShopifyAuthError(res.status);
    if (res.status >= 500) throw new ShopifyRetryableError(`Shopify HTTP ${String(res.status)}`);
    if (!res.ok) throw new ShopifyRequestError(`Shopify HTTP ${String(res.status)}`);

    let body: GraphQLResponse<T>;
    try {
      body = (await res.json()) as GraphQLResponse<T>;
    } catch {
      throw new ShopifyRetryableError('Shopify returned a non-JSON body');
    }
    if (body.errors !== undefined && body.errors.length > 0) {
      if (isThrottle(body.errors)) throw new ShopifyRetryableError('Shopify query cost throttled');
      const messages = body.errors.map((e) => e.message ?? 'unknown').join('; ');
      throw new ShopifyRequestError(`Shopify GraphQL error: ${messages.slice(0, 300)}`);
    }
    if (body.data === undefined) throw new ShopifyRequestError('Shopify response had no data');
    return body.data;
  };

  return {
    async request<T>(query: string, variables: Readonly<Record<string, unknown>> = {}): Promise<T> {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await once<T>(query, variables);
        } catch (error) {
          if (!(error instanceof ShopifyRetryableError) || attempt >= maxAttempts) throw error;
          const wanted =
            error.retryAfterSec === null ? 250 * 2 ** (attempt - 1) : error.retryAfterSec * 1000;
          // A long Retry-After is the caller's retry to schedule, not ours to sleep through.
          if (wanted > maxBackoffMs) throw error;
          await sleep(wanted);
        }
      }
    },
  };
}
