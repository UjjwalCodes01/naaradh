/**
 * Error codes are part of the contract: they reach merchants through the public API and the
 * dashboard, and they drive retry behaviour in the workers. Adding one is cheap; changing
 * the meaning of an existing one is a breaking change.
 *
 * CLAUDE.md: "never throw strings".
 */
export const ERROR_CODES = [
  /** A gate in packages/compliance refused the call. `reason` carries the specific gate. */
  'GATED',
  /** Engine is unreachable or circuit-open. Intent stays SCHEDULED; retry later. */
  'ENGINE_UNAVAILABLE',
  /** A duplicate request arrived; the original response is being returned. Not a failure. */
  'IDEMPOTENT_REPLAY',
  /** Inbound webhook signature did not verify. Answer 401 and do not parse the body. */
  'SIGNATURE_INVALID',
  /** Request body failed Zod validation at a boundary. */
  'VALIDATION_FAILED',
  /** No or invalid credentials. */
  'UNAUTHENTICATED',
  /** Caller is authenticated but not permitted (wrong tenant, insufficient role, scope). */
  'FORBIDDEN',
  /** Rate limit or spend cap hit. Carries retryAfterSec where known. */
  'RATE_LIMITED',
  /** Referenced row does not exist, or is invisible under the current RLS tenant context. */
  'NOT_FOUND',
  /** Vendor accepted the request but the outcome is unknown: poll before retrying. */
  'DISPATCH_UNCERTAIN',
  /** Something we did not anticipate. Should be rare enough to alert on. */
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface NaaradhErrorOptions {
  /** Structured, non-PII context for logs. Never put a dialable number in here. */
  readonly context?: Readonly<Record<string, string | number | boolean | null>>;
  readonly cause?: unknown;
  /** Whether a caller or worker may retry this operation unchanged. */
  readonly retryable?: boolean;
  readonly retryAfterSec?: number;
}

export class NaaradhError extends Error {
  readonly code: ErrorCode;
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
  readonly retryable: boolean;
  readonly retryAfterSec: number | undefined;

  constructor(code: ErrorCode, message: string, options: NaaradhErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.context = options.context ?? {};
    this.retryable = options.retryable ?? false;
    this.retryAfterSec = options.retryAfterSec;
  }
}

/**
 * A call was refused by the compliance gate. This is a normal, expected outcome — most
 * gated intents are the system working correctly — so it is never logged at error level.
 * `reason` is the machine-readable gate reason (e.g. 'window:transactional_expired') that
 * the dashboard turns into a plain-language explanation for the merchant.
 */
export class GatedError extends NaaradhError {
  readonly reason: string;

  constructor(reason: string, message: string, options: NaaradhErrorOptions = {}) {
    super('GATED', message, options);
    this.reason = reason;
  }
}

export class SignatureInvalidError extends NaaradhError {
  constructor(source: string) {
    super('SIGNATURE_INVALID', `Signature verification failed for ${source}`, {
      context: { source },
    });
  }
}

export class IdempotentReplayError extends NaaradhError {
  constructor(key: string) {
    super('IDEMPOTENT_REPLAY', 'Request already processed', { context: { idempotency_key: key } });
  }
}

export function isNaaradhError(value: unknown): value is NaaradhError {
  return value instanceof NaaradhError;
}
