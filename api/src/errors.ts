import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { isNaaradhError, type ErrorCode } from '@naaradh/shared';

/** HTTP status per error code. Anything unmapped is a 500 with a request id, no internals. */
const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  GATED: 409,
  ENGINE_UNAVAILABLE: 503,
  IDEMPOTENT_REPLAY: 200,
  SIGNATURE_INVALID: 401,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  DISPATCH_UNCERTAIN: 500,
  CONFLICT: 409,
  INTERNAL: 500,
};

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; request_id: string };
}

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = request.id;
  if (error instanceof ZodError) {
    void reply.code(422).send({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'request did not match the schema',
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        request_id: requestId,
      },
    } satisfies ApiErrorBody);
    return;
  }
  if (isNaaradhError(error)) {
    const status = STATUS_BY_CODE[error.code];
    if (error.retryAfterSec !== undefined)
      void reply.header('retry-after', String(error.retryAfterSec));
    void reply.code(status).send({
      error: {
        code: error.code,
        message: error.message,
        details: error.context,
        request_id: requestId,
      },
    } satisfies ApiErrorBody);
    return;
  }
  const fastifyStatus = (error as FastifyError).statusCode;
  if (fastifyStatus !== undefined && fastifyStatus < 500) {
    void reply.code(fastifyStatus).send({
      error: {
        code: (error as FastifyError).code,
        message: error.message,
        request_id: requestId,
      },
    } satisfies ApiErrorBody);
    return;
  }
  request.log.error({ err: error }, 'unhandled error');
  void reply.code(500).send({
    error: { code: 'INTERNAL', message: 'internal error', request_id: requestId },
  } satisfies ApiErrorBody);
}
