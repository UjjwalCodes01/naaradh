import type { IncomingHttpHeaders } from 'node:http';

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
