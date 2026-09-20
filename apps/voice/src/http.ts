import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyRequest } from 'fastify';
import type { EngineHttpRequestInfo } from '@naaradh/engines-core';

export function headersOf(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]),
  );
}

/** Postgres unique_violation, possibly wrapped by the driver or drizzle. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let e: unknown = error;
  for (let i = 0; i < 4 && e !== null && typeof e === 'object'; i += 1) {
    const rec = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (rec.code === '23505') return constraint === undefined || rec.constraint === constraint;
    e = rec.cause;
  }
  return false;
}

/** A GET has no body; adapters that read the query string get an empty buffer. */
export function bodyOf(body: unknown): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.alloc(0);
}

/** The request line for adapters whose vendor puts data in the URL (EngineHttpRequestInfo). */
export function httpInfoOf(request: FastifyRequest): EngineHttpRequestInfo {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries((request.query ?? {}) as Record<string, unknown>))
    if (typeof v === 'string') query[k] = v;
  return { method: request.method, path: request.url.split('?')[0] ?? request.url, query };
}
